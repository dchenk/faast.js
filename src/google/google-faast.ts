import { AbortController } from "abort-controller";
import { Gaxios, GaxiosOptions, GaxiosPromise } from "gaxios";
import {
    cloudbilling_v1,
    cloudfunctions_v1,
    google,
    GoogleApis,
    pubsub_v1
} from "googleapis";
import * as util from "util";
import { caches } from "../cache";
import { CostMetric, CostSnapshot } from "../cost";
import { assertNever, FaastError } from "../error";
import { log } from "../log";
import { packer, PackerResult } from "../packer";
import {
    CleanupOptions,
    commonDefaults,
    CommonOptions,
    FunctionStats,
    Invocation,
    PollResult,
    ProviderImpl,
    ResponseMessage,
    UUID
} from "../provider";
import {
    computeHttpResponseBytes,
    hasExpired,
    keysOf,
    sleep,
    uuidv4Pattern
} from "../shared";
import { retryOp, throttle } from "../throttle";
import { Mutable } from "../types";
import { WrapperOptions } from "../wrapper";
import { publishPubSub, receiveMessages } from "./google-queue";
import * as googleTrampolineHttps from "./google-trampoline-https";
import * as googleTrampolineQueue from "./google-trampoline-queue";

import CloudFunctions = cloudfunctions_v1;
import PubSubApi = pubsub_v1;
import CloudBilling = cloudbilling_v1;

const gaxios = new Gaxios();

/**
 * Valid Google Cloud
 * {@link https://cloud.google.com/compute/docs/regions-zones/ | regions}.
 * Only some of these [regions have Cloud Functions](https://cloud.google.com/functions/docs/locations).
 * @public
 */
export type GoogleRegion =
    | "asia-east1"
    | "asia-east2"
    | "asia-northeast1"
    | "asia-south1"
    | "asia-southeast1"
    | "australia-southeast1"
    | "europe-north1"
    | "europe-west1"
    | "europe-west2"
    | "europe-west3"
    | "europe-west4"
    | "europe-west6"
    | "northamerica-northeast1"
    | "southamerica-east1"
    | "us-central1"
    | "us-east1"
    | "us-east4"
    | "us-west1"
    | "us-west2";

const GoogleCloudFunctionsMemorySizes = [128, 256, 512, 1024, 2048];

/**
 * Google-specific options for {@link faastGoogle}. Extends
 * {@link CommonOptions}.
 * @public
 */
export interface GoogleOptions extends CommonOptions {
    /**
     * The region to create resources in. Garbage collection is also limited to
     * this region. Default: `"us-central1"`.
     */
    region?: GoogleRegion;
    /**
     * Additional options to pass to Google Cloud Function creation. See
     * {@link https://cloud.google.com/functions/docs/reference/rest/v1/projects.locations.functions#CloudFunction | projects.locations.functions}.
     * @remarks
     * If you need specialized options, you can pass them to the Google Cloud
     * Functions API directly. Note that if you override any settings set by
     * faast.js, you may cause faast.js to not work:
     *
     * ```typescript
     *  const requestBody: CloudFunctions.Schema$CloudFunction = {
     *      name,
     *      entryPoint: "trampoline",
     *      timeout,
     *      availableMemoryMb,
     *      sourceUploadUrl,
     *      runtime: "nodejs8",
     *      ...googleCloudFunctionOptions
     *  };
     * ```
     *
     */
    googleCloudFunctionOptions?: CloudFunctions.Schema$CloudFunction;

    /** @internal */
    _gcWorker?: (resources: GoogleResources, services: GoogleServices) => Promise<void>;
}

export interface GoogleResources {
    trampoline: string;
    requestQueueTopic?: string;
    responseQueueTopic?: string;
    responseSubscription?: string;
    region: string;
}

export interface GoogleCloudPricing {
    perInvocation: number;
    perGhzSecond: number;
    perGbSecond: number;
    perGbOutboundData: number;
    perGbPubSub: number;
}

export class GoogleMetrics {
    outboundBytes = 0;
    pubSubBytes = 0;
}

export interface GoogleServices {
    readonly cloudFunctions: CloudFunctions.Cloudfunctions;
    readonly pubsub: PubSubApi.Pubsub;
    readonly google: GoogleApis;
    readonly cloudBilling: CloudBilling.Cloudbilling;
}

export interface GoogleState {
    resources: GoogleResources;
    services: GoogleServices;
    url?: string;
    project: string;
    functionName: string;
    metrics: GoogleMetrics;
    options: Required<GoogleOptions>;
    gcPromise?: Promise<void>;
}

export function defaultGcWorker(resources: GoogleResources, services: GoogleServices) {
    return deleteResources(services, resources, log.gc);
}

export const defaults: Required<GoogleOptions> = {
    ...commonDefaults,
    region: "us-central1",
    googleCloudFunctionOptions: {},
    _gcWorker: defaultGcWorker
};

export const GoogleImpl: ProviderImpl<GoogleOptions, GoogleState> = {
    name: "google",
    initialize,
    defaults,
    cleanup,
    costSnapshot,
    logUrl,
    invoke,
    poll,
    responseQueueId
};

export async function initializeGoogleServices(): Promise<GoogleServices> {
    google.options({
        retryConfig: {
            retry: 12,
            statusCodesToRetry: [[100, 199], [429, 429], [405, 405], [500, 599]]
        }
    });
    const auth = await google.auth.getClient({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"]
    });

    google.options({ auth });
    return {
        cloudFunctions: google.cloudfunctions("v1"),
        pubsub: google.pubsub("v1"),
        cloudBilling: google.cloudbilling("v1"),
        google
    };
}

interface PollOptions {
    maxRetries?: number;
    delay?: (retries: number) => Promise<void>;
}

interface PollConfig<T> extends PollOptions {
    request: () => Promise<T>;
    checkDone: (result: T) => boolean;
}

async function defaultPollDelay(retries: number) {
    if (retries > 5) {
        await sleep(5 * 1000);
    }
    await sleep((retries + 1) * 500);
}

async function pollOperation<T>({
    request,
    checkDone,
    delay = defaultPollDelay,
    maxRetries = 50
}: PollConfig<T>): Promise<T | undefined> {
    let retries = 0;
    await delay(retries);
    while (true) {
        log.info(`Polling...`);
        const result = await request();
        if (checkDone(result)) {
            log.info(`Done.`);
            return result;
        }
        if (retries++ >= maxRetries) {
            throw new FaastError(`Timed out after ${retries} attempts.`);
        }
        await delay(retries);
    }
}

async function quietly<T>(promise: GaxiosPromise<T>) {
    try {
        const result = await promise;
        return result.data;
    } catch (err) {
        return;
    }
}

async function waitFor(
    api: CloudFunctions.Cloudfunctions,
    response: GaxiosPromise<CloudFunctions.Schema$Operation>
) {
    try {
        const operation = await response;
        const operationName = operation.data.name!;
        return pollOperation({
            request: () => quietly(api.operations.get({ name: operationName })),
            checkDone: result => {
                if (!result || result.error) {
                    return false;
                }
                return result.done || false;
            }
        });
    } catch (err) {
        throw new FaastError(err, "operation failed");
    }
}

// XXX wait for deletion; if the function doesn't exist then stop immediately, don't retry.
async function deleteFunction(api: CloudFunctions.Cloudfunctions, path: string) {
    return waitFor(
        api,
        api.projects.locations.functions.delete({
            name: path
        })
    );
}

export async function initialize(
    fmodule: string,
    nonce: UUID,
    options: Required<GoogleOptions>,
    parentDir: string
): Promise<GoogleState> {
    log.info(`Create google cloud function`);
    const services = await initializeGoogleServices();
    const project = await google.auth.getProjectId();
    const { cloudFunctions, pubsub } = services;
    const { region } = options;
    const location = `projects/${project}/locations/${region}`;
    const functionName = "faast-" + nonce;

    const { timeout } = options;
    async function createCodeBundle() {
        const wrapperOptions = {
            childProcessTimeoutMs: timeout * 1000 - 150
        };
        const { archive } = await googlePacker(
            fmodule,
            parentDir,
            options,
            wrapperOptions,
            functionName
        );
        const uploadUrlResponse = await cloudFunctions.projects.locations.functions.generateUploadUrl(
            {
                parent: location
            }
        );

        const uploadResult = await uploadZip(uploadUrlResponse.data.uploadUrl!, archive);
        log.info(`Upload zip file response: ${uploadResult.statusText}`);
        return uploadUrlResponse.data.uploadUrl;
    }

    const trampoline = `projects/${project}/locations/${region}/functions/${functionName}`;

    const resources: Mutable<GoogleResources> = {
        trampoline,
        region
    };
    const state: GoogleState = {
        resources,
        services,
        project,
        functionName,
        metrics: new GoogleMetrics(),
        options
    };

    const { gc, retentionInDays, _gcWorker: gcWorker } = options;
    if (gc) {
        log.gc(`Starting garbage collector`);
        state.gcPromise = collectGarbage(gcWorker, services, project, retentionInDays);
        state.gcPromise.catch(_silenceWarningLackOfSynchronousCatch => {});
    }

    const pricingPromise = getGoogleCloudFunctionsPricing(services.cloudBilling, region);

    const { mode } = options;

    const responseQueuePromise = (async () => {
        const topic = await pubsub.projects.topics.create({
            name: getResponseQueueTopic(project, functionName)
        });

        resources.responseQueueTopic = topic.data.name;
        resources.responseSubscription = getResponseSubscription(project, functionName);
        log.info(`Creating response queue subscription`);
        await pubsub.projects.subscriptions.create({
            name: resources.responseSubscription,
            requestBody: {
                topic: resources.responseQueueTopic
            }
        });
    })();

    let requestQueuePromise;
    if (mode === "queue") {
        log.info(`Initializing queue`);
        resources.requestQueueTopic = getRequestQueueTopic(project, functionName);
        requestQueuePromise = pubsub.projects.topics.create({
            name: resources.requestQueueTopic
        });
    }

    const sourceUploadUrl = await createCodeBundle();
    const { memorySize, googleCloudFunctionOptions } = options;
    if (!GoogleCloudFunctionsMemorySizes.find(size => size === memorySize)) {
        log.warn(`Invalid memorySize ${memorySize} for Google Cloud Functions`);
    }
    const requestBody: CloudFunctions.Schema$CloudFunction = {
        name: trampoline,
        entryPoint: "trampoline",
        timeout: `${timeout}s`,
        availableMemoryMb: memorySize,
        sourceUploadUrl,
        runtime: "nodejs8",
        ...googleCloudFunctionOptions
    };
    if (mode === "queue") {
        await requestQueuePromise;
        requestBody.eventTrigger = {
            eventType: "providers/cloud.pubsub/eventTypes/topic.publish",
            resource: resources.requestQueueTopic
        };
    } else {
        requestBody.httpsTrigger = {};
    }
    log.info(`Create function at ${location}`);
    log.info(`Request body: %O`, requestBody);
    try {
        log.info(`create function ${requestBody.name}`);
        await waitFor(
            cloudFunctions,
            cloudFunctions.projects.locations.functions.create({
                location,
                requestBody
            })
        );
    } catch (err) {
        await deleteFunction(cloudFunctions, trampoline).catch(() => {});
        throw new FaastError(err, "failed to create google cloud function");
    }
    if (mode === "https" || mode === "auto") {
        try {
            const func = await cloudFunctions.projects.locations.functions.get({
                name: trampoline
            });

            if (!func.data.httpsTrigger) {
                throw new FaastError("Could not get http trigger url");
            }
            const { url } = func.data.httpsTrigger!;
            if (!url) {
                throw new FaastError("Could not get http trigger url");
            }
            log.info(`Function URL: ${url}`);
            state.url = url;
        } catch (err) {
            throw new FaastError(
                err,
                `Could not get function ${trampoline} or its url, despite it being created`
            );
        }
    }
    await pricingPromise;
    await responseQueuePromise;
    return state;
}

function getRequestQueueTopic(project: string, functionName: string) {
    return `projects/${project}/topics/${functionName}-Requests`;
}

export function getResponseQueueTopic(project: string, functionName: string) {
    return `projects/${project}/topics/${functionName}-Responses`;
}

export function getResponseSubscription(project: string, functionName: string) {
    return `projects/${project}/subscriptions/${functionName}-Responses`;
}

async function callFunctionHttps(
    url: string,
    call: Invocation,
    metrics: GoogleMetrics,
    cancel: Promise<void>
): Promise<ResponseMessage | void> {
    const source = new AbortController();
    try {
        const axiosConfig: GaxiosOptions = {
            method: "PUT",
            url,
            headers: { "Content-Type": "text/plain" },
            body: call.body,
            signal: source.signal
        };
        const rawResponse = await Promise.race([
            gaxios.request<string>(axiosConfig),
            cancel
        ]);

        if (!rawResponse) {
            log.info(`cancelling gcp invoke`);
            source.abort();
            return;
        }
        const returned: string = rawResponse.data;
        metrics.outboundBytes += computeHttpResponseBytes(rawResponse!.headers);
        return {
            kind: "response",
            callId: call.callId,
            body: returned,
            rawResponse,
            timestamp: Date.now()
        };
    } catch (err) {
        const { response } = err;
        if (response && response.status === 503) {
            throw new FaastError(err, "google cloud function: possibly out of memory");
        }
        throw new FaastError(
            err,
            `google cloud function: ${response.statusText} ${response.data}`
        );
    }
}

async function invoke(
    state: GoogleState,
    call: Invocation,
    cancel: Promise<void>
): Promise<ResponseMessage | void> {
    const { options, resources, services, url, metrics } = state;
    switch (options.mode) {
        case "auto":
        case "https":
            return callFunctionHttps(url!, call, metrics, cancel);
        case "queue":
            const { requestQueueTopic } = resources;
            const { pubsub } = services;
            publishPubSub(pubsub, requestQueueTopic!, call.body);
            return;
        default:
            assertNever(options.mode);
    }
}

function poll(state: GoogleState, cancel: Promise<void>): Promise<PollResult> {
    return receiveMessages(
        state.services.pubsub,
        state.resources.responseSubscription!,
        state.metrics,
        cancel
    );
}

function responseQueueId(state: GoogleState): string | undefined {
    return state.resources.responseQueueTopic;
}

async function deleteResources(
    services: GoogleServices,
    resources: GoogleResources,
    output: (msg: string) => void = log.info
) {
    const {
        trampoline,
        requestQueueTopic,
        responseSubscription,
        responseQueueTopic,
        region,
        ...rest
    } = resources;
    const _exhaustiveCheck: Required<typeof rest> = {};
    const { cloudFunctions, pubsub } = services;

    if (responseSubscription) {
        if (
            await quietly(
                pubsub.projects.subscriptions.delete({
                    subscription: responseSubscription
                })
            )
        ) {
            output(`Deleted response subscription: ${responseSubscription}`);
        }
    }
    if (responseQueueTopic) {
        if (await quietly(pubsub.projects.topics.delete({ topic: responseQueueTopic }))) {
            output(`Deleted response queue topic: ${responseQueueTopic}`);
        }
    }
    if (requestQueueTopic) {
        if (await quietly(pubsub.projects.topics.delete({ topic: requestQueueTopic }))) {
            output(`Deleted request queue topic: ${requestQueueTopic}`);
        }
    }
    if (trampoline) {
        if (await deleteFunction(cloudFunctions, trampoline)) {
            output(`Deleted function ${trampoline}`);
        }
    }
}

export async function cleanup(state: GoogleState, options: CleanupOptions) {
    log.info(`google cleanup starting.`);
    if (state.gcPromise) {
        try {
            log.info(`Waiting for garbage collection...`);
            await state.gcPromise;
            log.info(`Garbage collection done.`);
        } catch (err) {
            throw new FaastError(err, "garbage collection failed");
        }
    }

    if (options.deleteResources) {
        try {
            await deleteResources(state.services, state.resources);
        } catch (err) {
            throw new FaastError(err, "delete resources failed");
        }
    }
    log.info(`google cleanup done.`);
}

let garbageCollectorRunning = false;

async function collectGarbage(
    gcWorker: typeof defaultGcWorker,
    services: GoogleServices,
    proj: string,
    retentionInDays: number
) {
    if (gcWorker === defaultGcWorker) {
        if (garbageCollectorRunning) {
            return;
        }
        garbageCollectorRunning = true;
    }
    try {
        const { cloudFunctions } = services;

        let pageToken: string | undefined;

        let promises = [];
        const scheduleDeleteResources = throttle(
            {
                concurrency: 5,
                rate: 5,
                burst: 2
            },
            async (
                gServices: GoogleServices,
                fn: CloudFunctions.Schema$CloudFunction
            ) => {
                const { region, name, project } = parseFunctionName(fn.name!)!;

                const resources: GoogleResources = {
                    region,
                    trampoline: fn.name!,
                    requestQueueTopic: getRequestQueueTopic(project, name),
                    responseQueueTopic: getResponseQueueTopic(project, name),
                    responseSubscription: getResponseSubscription(project, name)
                };
                await gcWorker(resources, gServices);
            }
        );

        const fnPattern = new RegExp(`/functions/faast-${uuidv4Pattern}$`);
        do {
            const funcListResponse = await cloudFunctions.projects.locations.functions.list(
                {
                    parent: `projects/${proj}/locations/-`,
                    pageToken
                }
            );

            pageToken = funcListResponse.data.nextPageToken;
            const garbageFunctions = (funcListResponse.data.functions || [])
                .filter(fn => hasExpired(fn.updateTime, retentionInDays))
                .filter(fn => fn.name!.match(fnPattern));

            promises = garbageFunctions.map(fn => scheduleDeleteResources(services, fn));
        } while (pageToken);

        await Promise.all(promises);
    } finally {
        if (gcWorker === defaultGcWorker) {
            garbageCollectorRunning = false;
        }
    }
}

function parseFunctionName(path: string) {
    const match = path.match(/^projects\/(.*)\/locations\/(.*)\/functions\/(.*)$/);
    return match && { project: match[1], region: match[2], name: match[3] };
}

async function uploadZip(url: string, zipStream: NodeJS.ReadableStream) {
    const config: GaxiosOptions = {
        method: "PUT",
        url,
        body: zipStream,
        headers: {
            "content-type": "application/zip",
            "x-goog-content-length-range": "0,104857600"
        },
        retryConfig: {
            retry: 5
        }
    };
    return gaxios.request(config);
}

export async function googlePacker(
    functionModule: string,
    parentDir: string,
    options: CommonOptions,
    wrapperOptions: WrapperOptions,
    FunctionName: string
): Promise<PackerResult> {
    const { mode } = options;
    const trampolineModule =
        mode === "queue" ? googleTrampolineQueue : googleTrampolineHttps;
    return packer(
        parentDir,
        trampolineModule,
        functionModule,
        options,
        wrapperOptions,
        FunctionName
    );
}

const getGooglePrice = throttle(
    { concurrency: 1, rate: 3, retry: 3, memoize: true, cache: caches.googlePrices },
    async (
        cloudBilling: CloudBilling.Cloudbilling,
        region: string,
        serviceName: string,
        description: string,
        conversionFactor: number
    ) => {
        try {
            const skusResponse = await cloudBilling.services.skus.list({
                parent: serviceName
            });
            const { skus = [] } = skusResponse.data;
            const matchingSkus = skus.filter(sku => sku.description === description);
            log.provider(`matching SKUs: ${util.inspect(matchingSkus, { depth: null })}`);

            const regionOrGlobalSku =
                matchingSkus.find(sku => sku.serviceRegions![0] === region) ||
                matchingSkus.find(sku => sku.serviceRegions![0] === "global");

            const pexp = regionOrGlobalSku!.pricingInfo![0].pricingExpression!;
            const prices = pexp.tieredRates!.map(
                rate =>
                    Number(rate.unitPrice!.units || "0") + rate.unitPrice!.nanos! / 1e9
            );
            const price =
                Math.max(...prices) * (conversionFactor / pexp.baseUnitConversionFactor!);
            log.provider(
                `Found price for ${serviceName}, ${description}, ${region}: ${price}`
            );
            return price;
        } catch (err) {
            throw new FaastError(
                err,
                `failed to get google pricing for "${description}"`
            );
        }
    }
);

let googleServices: cloudbilling_v1.Schema$Service[] | undefined;

const listGoogleServices = throttle(
    { concurrency: 1 },
    async (cloudBilling: CloudBilling.Cloudbilling) => {
        if (googleServices) {
            return googleServices;
        }
        const response = await cloudBilling.services.list();
        googleServices = response.data.services!;
        return googleServices;
    }
);

async function getGoogleCloudFunctionsPricing(
    cloudBilling: CloudBilling.Cloudbilling,
    region: string
): Promise<GoogleCloudPricing> {
    const services = await listGoogleServices(cloudBilling);

    const getPricing = (
        serviceName: string,
        description: string,
        conversionFactor: number = 1
    ) => {
        const service = services.find(s => s.displayName === serviceName)!;

        return getGooglePrice(
            cloudBilling,
            region,
            service.name!,
            description,
            conversionFactor
        );
    };

    return {
        perInvocation: await getPricing("Cloud Functions", "Invocations"),
        perGhzSecond: await getPricing("Cloud Functions", "CPU Time"),
        perGbSecond: await getPricing("Cloud Functions", "Memory Time", 2 ** 30),
        perGbOutboundData: await getPricing(
            "Cloud Functions",
            `Network Egress from ${region}`,
            2 ** 30
        ),
        perGbPubSub: await getPricing("Cloud Pub/Sub", "Message Delivery Basic", 2 ** 30)
    };
}

// https://cloud.google.com/functions/pricing
const gcfProvisonableMemoryTable: { [mem: number]: number } = {
    128: 0.2,
    256: 0.4,
    512: 0.8,
    1024: 1.4,
    2048: 2.4
};

async function costSnapshot(
    state: GoogleState,
    stats: FunctionStats
): Promise<CostSnapshot> {
    const costs = new CostSnapshot("google", state.options, stats);
    const { memorySize = defaults.memorySize } = state.options;
    const provisionableSizes = keysOf(gcfProvisonableMemoryTable)
        .map(n => Number(n))
        .sort((a, b) => a - b);
    const provisionedMb = provisionableSizes.find(size => memorySize <= size);
    if (!provisionedMb) {
        log.warn(
            `Could not determine provisioned memory or CPU for requested memory size ${memorySize}`
        );
    }
    const provisionedGhz = gcfProvisonableMemoryTable[provisionedMb!];
    const billedTimeStats = stats.estimatedBilledTime;
    const seconds = (billedTimeStats.mean / 1000) * billedTimeStats.samples;

    const { region } = state.resources;
    const prices = await getGoogleCloudFunctionsPricing(
        state.services.cloudBilling,
        region
    );

    const provisionedGb = provisionedMb! / 1024;
    const functionCallDuration = new CostMetric({
        name: "functionCallDuration",
        pricing:
            prices.perGbSecond * provisionedGb + prices.perGhzSecond * provisionedGhz,
        unit: "second",
        measured: seconds,
        comment: `https://cloud.google.com/functions/pricing#compute_time (${provisionedMb} MB, ${provisionedGhz} GHz)`
    });
    costs.push(functionCallDuration);

    const functionCallRequests = new CostMetric({
        name: "functionCallRequests",
        pricing: prices.perInvocation,
        measured: stats.invocations,
        unit: "request",
        comment: "https://cloud.google.com/functions/pricing#invocations"
    });
    costs.push(functionCallRequests);

    const outboundDataTransfer = new CostMetric({
        name: "outboundDataTransfer",
        pricing: prices.perGbOutboundData,
        measured: state.metrics.outboundBytes / 2 ** 30,
        unit: "GB",
        comment: "https://cloud.google.com/functions/pricing#networking"
    });
    costs.push(outboundDataTransfer);

    const pubsub = new CostMetric({
        name: "pubsub",
        pricing: prices.perGbPubSub,
        measured: state.metrics.pubSubBytes / 2 ** 30,
        unit: "GB",
        comment: "https://cloud.google.com/pubsub/pricing"
    });
    costs.push(pubsub);

    return costs;
}

export function logUrl(state: GoogleState) {
    const { project, functionName } = state;
    return `https://console.cloud.google.com/logs/viewer?project=${project}&resource=cloud_function%2Ffunction_name%2F${functionName}`;
}
