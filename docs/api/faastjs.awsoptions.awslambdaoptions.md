[Home](./index) &gt; [faastjs](./faastjs.md) &gt; [AwsOptions](./faastjs.awsoptions.md) &gt; [awsLambdaOptions](./faastjs.awsoptions.awslambdaoptions.md)

## AwsOptions.awsLambdaOptions property

Additional options to pass to AWS Lambda creation.

<b>Signature:</b>

```typescript
awsLambdaOptions?: Partial<aws.Lambda.Types.CreateFunctionRequest>;
```

## Remarks

If you need specialized options, you can pass them to the AWS Lambda SDK directly. Note that if you override any settings set by faast.js, you may cause faast.js to not work:

```typescript
  const request: aws.Lambda.Types.CreateFunctionRequest = {
      FunctionName,
      Role,
      Runtime: "nodejs8.10",
      Handler: "index.trampoline",
      Code,
      Description: "faast trampoline function",
      Timeout,
      MemorySize,
      DeadLetterConfig: { TargetArn: responseQueueArn },
      ...awsLambdaOptions
  };

```
One use case for this option is to use [Lambda Layers](https://docs.aws.amazon.com/lambda/latest/dg/configuration-layers.html) with faast.js.
