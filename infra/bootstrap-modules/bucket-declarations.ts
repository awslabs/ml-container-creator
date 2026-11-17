// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Typed access to the per-stack bucket declarations (`<stack dir>/buckets.json`).
 *
 * Every MLCC bucket name is spelled exactly once, in the owning stack's
 * buckets.json (ADR-008 derive-dont-hardcode; bucket consolidation R1.2). Stacks
 * render the physical name through renderBucketName() and decide create-vs-adopt
 * through declaredBucket(). module-runner.cjs reads the SAME files through
 * bucket-declarations.cjs (plain CommonJS, no build step) to derive adopt flags and
 * the implicit bucket-import plan; test/unit/no-literal-bucket-names.test.js asserts the two
 * renderers agree and that no other file spells a bucket name.
 */
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface BucketDeclaration {
    /** Physical-name template. Placeholders: {account} {region} {profile}. */
    name: string;
    /** CDK context key the runner sets when the bucket exists but is NOT a resource of this stack. */
    adoptContext: string;
    /** CfnOutput logical ID that carries the name (the runner strips a trailing 'Output'). */
    output?: string;
    /** Flat profile key _denormalizeModuleOutputs writes from the output. */
    profileKey?: string;
    /** Env var do/lib/profile.sh exports from the profile key. */
    envVar?: string;
    /** Frozen legacy bucket: kept (and imported) for recorded URIs; no new writes. */
    legacy?: boolean;
    purpose?: string;
}

export interface StackBucketDeclarations {
    stack: string;
    buckets: Record<string, BucketDeclaration>;
}

export interface BucketNameVars {
    account: string;
    region: string;
    profileName?: string;
}

/**
 * Render a declared bucket-name template. Uses split/join (not String.replace) so a
 * CDK token string such as `${Token[AWS.AccountId.1]}` is inserted verbatim.
 */
export function renderBucketName(decl: Pick<BucketDeclaration, 'name'>, vars: BucketNameVars): string {
    return decl.name
        .split('{account}').join(vars.account)
        .split('{region}').join(vars.region)
        .split('{profile}').join(vars.profileName || '');
}

/** Look up one declaration by its construct (logical) ID; throws on a typo. */
export function bucketDeclaration(decls: StackBucketDeclarations, logicalId: string): BucketDeclaration {
    const decl = decls.buckets[logicalId];
    if (!decl) {
        throw new Error(`No bucket '${logicalId}' declared for stack '${decls.stack}' (see its buckets.json)`);
    }
    return decl;
}

/**
 * Create the declared bucket as a stack resource, or adopt it by reference when the
 * runner signalled (via the declaration's adoptContext) that the bucket exists but
 * is NOT yet a resource of this stack. The runner never sets the adopt flag for a
 * bucket this stack already owns, so an owned bucket is never orphaned
 * (DELETE_SKIPPED) by a later deploy (bucket consolidation R1.1).
 */
export function declaredBucket(
    scope: Construct,
    logicalId: string,
    bucketName: string,
    adopt: boolean | undefined,
    props: Omit<s3.BucketProps, 'bucketName' | 'removalPolicy'>
): s3.IBucket {
    if (adopt) {
        return s3.Bucket.fromBucketName(scope, logicalId, bucketName);
    }
    return new s3.Bucket(scope, logicalId, {
        ...props,
        bucketName,
        // Every MLCC bucket is RETAIN: data outlives the stack, and a resource
        // import requires a DeletionPolicy on the imported resource.
        removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
}
