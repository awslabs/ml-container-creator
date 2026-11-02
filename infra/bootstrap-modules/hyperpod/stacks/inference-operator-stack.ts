// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import INFERENCE_OPERATOR_BUCKETS from './buckets.json';
import {
    StackBucketDeclarations, bucketDeclaration, declaredBucket, renderBucketName,
} from '../../bucket-declarations';

/** The inference-operator stack's bucket declarations (single declared source, R1.2). */
export const BUCKETS: StackBucketDeclarations = INFERENCE_OPERATOR_BUCKETS;

export interface MlccInferenceOperatorStackProps extends cdk.StackProps {
    profileName: string;
    adoptTlsBucket?: boolean;
    adoptInferenceAddon?: boolean;
    // Consumed from Stack 1 + Stack 2 SSM params (passed as CDK context)
    eksClusterName?: string;
    hyperPodClusterArn?: string;
    hyperpodInferenceRoleArn?: string;
    albControllerRoleArn?: string;
    kedaOperatorRoleArn?: string;
    // Optional: a dedicated role for JumpStart GATED model downloads. Included in the
    // add-on config ONLY when present (empty would fail the IAM-ARN pattern validation).
    jumpstartGatedModelDownloadRoleArn?: string;
}

/**
 * Stack 3 of the HyperPod module: Installs the SageMaker HyperPod Inference
 * Operator as an EKS add-on, plus the TLS S3 bucket it requires.
 *
 * Inputs: All values come from Stack 1 + Stack 2 SSM params, passed as
 * CDK context by the multi-stack module runner.
 */
export class MlccInferenceOperatorStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccInferenceOperatorStackProps) {
        super(scope, id, props);

        const { profileName } = props;
        const region = this.region;
        const ssmPrefix = `/mlcc/${profileName}/hyperpod`;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'hyperpod');
        cdk.Tags.of(this).add('mlcc:profile', profileName);
        cdk.Tags.of(this).add('mlcc:stack', 'inference-operator');

        // Read inputs from context (injected by module runner from SSM)
        const eksClusterName = props.eksClusterName
            || this.node.tryGetContext('EksClusterName')
            || '';
        const hyperPodClusterArn = props.hyperPodClusterArn
            || this.node.tryGetContext('HyperPodClusterArn')
            || '';
        const hyperpodInferenceRoleArn = props.hyperpodInferenceRoleArn
            || this.node.tryGetContext('HyperpodInferenceRoleArn')
            || '';
        const albControllerRoleArn = props.albControllerRoleArn
            || this.node.tryGetContext('AlbControllerRoleArn')
            || '';
        const kedaOperatorRoleArn = props.kedaOperatorRoleArn
            || this.node.tryGetContext('KedaOperatorRoleArn')
            || '';

        // Validate required inputs — during destroy, context may be empty.
        // Return early (empty stack) so CDK can still find and destroy it.
        if (!hyperPodClusterArn) {
            return;
        }

        // ─── TLS S3 Bucket (RemovalPolicy.RETAIN) ───────────────────────────

        // NAMING AUDIT (BL161 R4 — ADR-012 Q3 corollary): the TLS bucket
        // (declared in ./buckets.json) is MLCC-OWNED and safe to carry the `mlcc-`
        // prefix. Nothing resolves it by a `sagemaker-`/`hyperpod-` prefix convention:
        //   - MLCC passes the name EXPLICITLY below as the add-on's
        //     `tlsCertificateS3Bucket` configurationValue (not discovered by prefix).
        //   - IAM is granted by EXACT ARN (eks-cluster-stack.ts HyperPodInferenceTlsBucketAccess).
        //   - The add-on's configurationSchema for `tlsCertificateS3Bucket` requires only
        //     the substring `tls`, which the declared TLS bucket name satisfies.
        // Census conclusion (BL161): every MLCC-chosen name in the eks + hyperpod
        // bootstrap modules is either MLCC-fully-owned (passed explicitly / exact-ARN /
        // live handle) or an AWS-canonical name (add-on names like
        // amazon-sagemaker-hyperpod-inference; chart namespaces/SAs like
        // hyperpod-inference-system / aws-load-balancer-controller) that already conforms.
        // NO name is resolved by a `mlcc-` prefix convention, so no rename is needed.
        const bucketName = renderBucketName(
            bucketDeclaration(BUCKETS, 'TlsBucket'),
            { account: this.account, region: this.region, profileName },
        );
        // Adopted by reference ONLY while the bucket exists but is not a resource of
        // this stack (the runner checks stack ownership before setting adoptTlsBucket).
        const tlsBucket = declaredBucket(this, 'TlsBucket', bucketName, props.adoptTlsBucket, {
            autoDeleteObjects: false,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // ─── Inference Operator EKS Add-on (CDK-owned — BL161) ──────────────
        // The inference add-on is a CDK resource (not an out-of-band `aws eks
        // create-addon` module-runner step), mirroring the four sibling
        // `eks.CfnAddon`s in eks-cluster-stack.ts. This makes create AND destroy
        // symmetric through the normal stack lifecycle — `cdk destroy` removes the
        // add-on with its stack, eliminating the old stale-`hyperpodClusterArn`
        // dangling-add-on wedge and the hand-rolled `_deleteInferenceAddon` hook.
        //
        // BL143 decoupling (R2): `AWS::EKS::Addon` completes when the add-on reaches
        // ACTIVE, which is DECOUPLED from the slow async `EnableClusterInference`
        // watcher enablement. The watcher verification stays a read-only, warn-not-block
        // post-deploy module-runner step (_ensureHyperPodClusterInferenceEnabled) — it is
        // not a CloudFormation concern and must not gate this stack.
        //
        // Build the config from stack props/context (R3) — the SAME blob the imperative
        // path assembled, now declarative. No runtime SSM read.
        const inferenceConfig: Record<string, unknown> = {
            executionRoleArn: hyperpodInferenceRoleArn,
            // The TLS bucket name is passed EXPLICITLY here (naming-audit guard, R4) —
            // never resolved by a service prefix.
            tlsCertificateS3Bucket: bucketName,
            hyperpodClusterArn: hyperPodClusterArn,
            // MLCC does NOT configure an Inference Gateway; the add-on defaults this ON,
            // so set it OFF explicitly (matches the console Quick Install).
            inferenceGateway: { enabled: false },
            alb: {
                enabled: true,
                serviceAccount: { create: false, roleArn: albControllerRoleArn },
            },
            keda: {
                enabled: true,
                auth: { aws: { irsa: { enabled: true, roleArn: kedaOperatorRoleArn } } },
            },
        };
        // Conditional: include jumpstartGatedModelDownloadRoleArn ONLY when present. The
        // add-on schema types this as an IAM role ARN (pattern ^arn:aws:iam::...:role/.+$),
        // so an empty string would FAIL configurationValues validation. MLCC does not
        // provision one by default; the console Quick Install does.
        const jumpstartGatedRoleArn = props.jumpstartGatedModelDownloadRoleArn
            || this.node.tryGetContext('JumpstartGatedModelDownloadRoleArn')
            || '';
        if (jumpstartGatedRoleArn) {
            inferenceConfig.jumpstartGatedModelDownloadRoleArn = jumpstartGatedRoleArn;
        }

        const inferenceAddon = new eks.CfnAddon(this, 'HyperPodInferenceAddon', {
            clusterName: eksClusterName,
            addonName: 'amazon-sagemaker-hyperpod-inference',
            // OQ-2 (addonVersion): the four sibling add-ons PIN a version, and pinning is
            // the repo default for reproducibility. The imperative path passed NO
            // --addon-version (it resolved the account/region default), which is the
            // known-working behavior; omitting here preserves exactly that resolution.
            // FLAG: pin `addonVersion` to the value `aws eks describe-addon-versions
            // --addon-name amazon-sagemaker-hyperpod-inference` reports once confirmed
            // against a live account (the version is AWS-published and cannot be
            // determined offline without fabricating a literal).
            resolveConflicts: 'OVERWRITE',
            configurationValues: JSON.stringify(inferenceConfig),
        });
        // The add-on consumes the TLS bucket; when MLCC creates it, ensure it exists
        // first. (An adopted bucket already exists, so no dependency is needed.)
        if (tlsBucket instanceof s3.Bucket) {
            inferenceAddon.node.addDependency(tlsBucket);
        }

        // ─── SSM Exports ────────────────────────────────────────────────────

        new ssm.StringParameter(this, 'InferenceOperatorStatusParam', {
            parameterName: `${ssmPrefix}/InferenceOperatorStatus`,
            stringValue: 'active',
            description: 'Inference Operator installation status',
        });

        // ─── CfnOutputs ────────────────────────────────────────────────────

        new cdk.CfnOutput(this, 'InferenceOperatorStatusOutput', {
            value: 'active',
            exportName: `mlcc-${profileName}-inference-InferenceOperatorStatus`,
        });

        new cdk.CfnOutput(this, 'TlsBucketNameOutput', {
            value: bucketName,
            exportName: `mlcc-${profileName}-inference-TlsBucketName`,
        });
    }
}
