import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MlccCiHarnessStack } from '../lib/ci-harness-stack';

/**
 * BL216: the benchmark writer (templates/do/.benchmark_writer.py, plus the
 * do/lib/python/pricing.py helper it loads) calls pricing:GetProducts and
 * reconciles existing Glue partitions (GetPartition / UpdatePartition) since
 * Wave 9B. The CI CodeBuild role runs that writer, so its benchmark write
 * policy must grant every action the writer calls.
 *
 * Drift guard (derive-dont-hardcode rule 4): the required action set is
 * DERIVED from the writer source, not hardcoded, and asserted against both
 * this stack and the bootstrap ci module (infra/bootstrap-modules/ci/stack.ts),
 * which grants the same writer actions to its own CodeBuild role.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const WRITER = join(REPO_ROOT, 'templates', 'do', '.benchmark_writer.py');
const PRICING_HELPER = join(REPO_ROOT, 'templates', 'do', 'lib', 'python', 'pricing.py');
const BOOTSTRAP_CI_STACK = join(REPO_ROOT, 'infra', 'bootstrap-modules', 'ci', 'stack.ts');

const GLUE_CATALOG_RESOURCES = [
    'arn:aws:glue:*:*:catalog',
    'arn:aws:glue:*:*:database/mlcc_ci',
    'arn:aws:glue:*:*:table/mlcc_ci/*',
];

/** boto3 snake_case method name to IAM action suffix (get_partition to GetPartition). */
function toIamAction(service: string, method: string): string {
    const pascal = method.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
    return `${service}:${pascal}`;
}

/** Every glue_client.<method>( call in the writer, mapped to its IAM action. */
function writerGlueActions(): string[] {
    const src = readFileSync(WRITER, 'utf8');
    const actions = new Set<string>();
    for (const m of src.matchAll(/glue_client\.([a-z_]+)\(/g)) {
        actions.add(toIamAction('glue', m[1]));
    }
    return [...actions].sort();
}

/** Pricing API calls the pricing helper makes (client.<method>( on the 'pricing' client). */
function pricingActions(): string[] {
    const src = readFileSync(PRICING_HELPER, 'utf8');
    assert.match(src, /boto3\.client\(\s*'pricing'/, 'pricing.py no longer builds a pricing client; re-derive');
    const actions = new Set<string>();
    for (const m of src.matchAll(/client\.(get_products|describe_services|get_attribute_values)\(/g)) {
        actions.add(toIamAction('pricing', m[1]));
    }
    return [...actions].sort();
}

/** Actions array of the addToPolicy statement with the given Sid in bootstrap ci/stack.ts. */
function bootstrapStatementActions(sid: string): string[] {
    const src = readFileSync(BOOTSTRAP_CI_STACK, 'utf8');
    const re = new RegExp(`sid:\\s*'${sid}',\\s*actions:\\s*\\[([^\\]]*)\\]`);
    const m = src.match(re);
    assert.ok(m, `bootstrap ci stack has no statement with sid ${sid}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

function asArray<T>(v: T | T[]): T[] {
    return Array.isArray(v) ? v : [v];
}

describe('Benchmark writer IAM (BL216)', () => {
    let template: Template;
    let statements: any[];
    let policyRoles: any[];

    before(() => {
        const app = new App();
        const stack = new MlccCiHarnessStack(app, 'BenchmarkWriterIamTestStack');
        template = Template.fromStack(stack);
        const policies = template.findResources('AWS::IAM::Policy', {
            Properties: { PolicyName: 'mlcc-ci-benchmark-write-policy' },
        });
        const ids = Object.keys(policies);
        assert.equal(ids.length, 1, 'expected exactly one benchmark write policy');
        statements = policies[ids[0]].Properties.PolicyDocument.Statement;
        policyRoles = policies[ids[0]].Properties.Roles;
    });

    function statementBySid(sid: string): any {
        const st = statements.find((s) => s.Sid === sid);
        assert.ok(st, `no statement with Sid ${sid}`);
        return st;
    }

    describe('derived writer call inventory', () => {
        it('the writer still calls the Glue partition APIs this guard expects', () => {
            const glue = writerGlueActions();
            for (const a of ['glue:GetTable', 'glue:BatchCreatePartition', 'glue:GetPartition', 'glue:UpdatePartition']) {
                assert.ok(glue.includes(a), `writer no longer calls ${a}; derived set: ${glue.join(', ')}`);
            }
        });

        it('the pricing helper calls pricing:GetProducts', () => {
            assert.ok(pricingActions().includes('pricing:GetProducts'));
        });
    });

    describe('ci-harness benchmark write policy', () => {
        it('is attached to the CodeBuild role that runs the writer', () => {
            const refs = asArray(policyRoles).map((r: any) => r.Ref);
            assert.ok(refs.some((r: string) => /^CodeBuildRole/.test(r)), `roles: ${JSON.stringify(policyRoles)}`);
        });

        it('grants every Glue action the writer calls', () => {
            const granted = asArray(statementBySid('GlueCatalogAccess').Action);
            for (const a of writerGlueActions()) {
                assert.ok(granted.includes(a), `GlueCatalogAccess missing ${a}`);
            }
        });

        it('keeps Glue scoped to catalog + database/mlcc_ci + table/mlcc_ci', () => {
            const st = statementBySid('GlueCatalogAccess');
            assert.equal(st.Effect, 'Allow');
            assert.deepEqual(asArray(st.Resource).sort(), [...GLUE_CATALOG_RESOURCES].sort());
        });

        it('grants pricing:GetProducts on * (Pricing API has no resource-level permissions)', () => {
            const st = statementBySid('BenchmarkPriceLookup');
            assert.equal(st.Effect, 'Allow');
            assert.deepEqual(asArray(st.Action), pricingActions());
            assert.equal(st.Resource, '*');
        });

        it('no other statement in the policy grants pricing or Glue partition writes', () => {
            for (const st of statements) {
                if (st.Sid === 'BenchmarkPriceLookup' || st.Sid === 'GlueCatalogAccess') continue;
                for (const a of asArray(st.Action) as string[]) {
                    assert.ok(!a.startsWith('pricing:') && !a.startsWith('glue:'), `${st.Sid} unexpectedly grants ${a}`);
                }
            }
        });
    });

    describe('conformance with bootstrap ci module', () => {
        it('bootstrap BenchmarkPartitionRegister grants exactly the writer Glue actions', () => {
            assert.deepEqual(bootstrapStatementActions('BenchmarkPartitionRegister'), writerGlueActions());
        });

        it('bootstrap BenchmarkPriceLookup grants exactly the writer pricing actions', () => {
            assert.deepEqual(bootstrapStatementActions('BenchmarkPriceLookup'), pricingActions());
        });

        it('ci-harness and bootstrap agree on the writer-required action set', () => {
            const harness = new Set<string>([
                ...asArray(statementBySid('GlueCatalogAccess').Action),
                ...asArray(statementBySid('BenchmarkPriceLookup').Action),
            ] as string[]);
            const bootstrap = [
                ...bootstrapStatementActions('BenchmarkPartitionRegister'),
                ...bootstrapStatementActions('BenchmarkPriceLookup'),
            ];
            for (const a of bootstrap) {
                assert.ok(harness.has(a), `bootstrap grants ${a} for the writer but ci-harness does not`);
            }
        });
    });
});
