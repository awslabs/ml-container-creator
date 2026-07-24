import ejs from 'ejs';
import { readFileSync } from 'fs';
const templateContent = readFileSync('/Users/frgud/KiroProjects/ml-container-creator/templates/do/config', 'utf8');
try {
  const output = ejs.render(templateContent, {
    orderedEnvVars: [], baseImage: '', inferenceAmiVersion: '1.0.0',
    ngcApiKey: undefined, icCpuCount: undefined, icMemorySize: undefined,
    icGpuCount: 1, icCopyCount: undefined, icModelWeight: undefined,
    endpointInitialInstanceCount: undefined, endpointDataCapturePercent: undefined,
    endpointVariantName: undefined, endpointVolumeSize: undefined,
    modelEnvVars: {}, serverEnvVars: {}, icEnvVars: {},
    asyncMaxConcurrentInvocations: undefined, asyncSnsSuccessTopic: undefined,
    asyncSnsErrorTopic: undefined, batchInstanceCount: 1, batchSplitType: 'Line',
    batchStrategy: 'SingleRecord', batchJoinSource: 'None',
    batchMaxConcurrentTransforms: 1, batchMaxPayloadInMB: 6,
    hyperPodCluster: '', hyperPodNamespace: 'default', hyperPodReplicas: 1,
    fsxVolumeHandle: undefined, instancePools: undefined,
    capacityReservationArn: undefined, deploy_mode: undefined,
    existingEndpointName: undefined, enableLora: undefined,
    hfToken: undefined, hfTokenArn: undefined, ngcTokenArn: undefined,
    modelName: 'test-model', tuneSupported: undefined, tuneModelId: undefined,
    container_image_uri: undefined,
    projectName: 'test-project', deploymentConfig: 'transformers-vllm',
    framework: 'transformers', modelServer: 'vllm',
    awsRegion: 'us-east-1', buildTarget: 'codebuild',
    codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
    deploymentTarget: 'realtime-inference', instanceType: 'ml.g5.xlarge'
  });
  console.log('OK len=' + output.length);
  console.log('DT:' + output.includes('DEPLOYMENT_TARGET'));
  console.log('HP:' + output.includes('HP_CLUSTER_NAME'));
} catch(e) {
  console.log('ERR:' + e.message.slice(0, 500));
}
