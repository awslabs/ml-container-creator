# Upgrading to v2

This page lists what changed for users moving from MLCC 1.x to v2 and what, if anything, you need to do. Each item links to the page with the details.

## Upgrade checklist

1. Install the new CLI and the Python dependencies the `do/` scripts use (`npm install` does not install them):

    ```bash
    npm install -g @aws/ml-container-creator
    uv pip install -r "$(npm root -g)/@aws/ml-container-creator/requirements.txt"
    ```

2. Re-apply your bootstrap stacks so the roles pick up new permissions (for example the MLflow → Model Registry bridge on the `core` role):

    ```bash
    ml-container-creator bootstrap update --dry-run   # preview (cdk diff per module)
    ml-container-creator bootstrap update
    ```

3. Re-render each existing project with the v2 generator. Run it from the project directory; deploy state and other runtime-owned `do/config` values are preserved:

    ```bash
    mcc regenerate --dry-run   # show what would change
    mcc regenerate
    ```

4. Move any plaintext Hugging Face / NGC token to Secrets Manager (see below), and drop `--deployment-target` from your generation scripts.

## Breaking or behavior changes

### Choose the deployment target at deploy time

`--deployment-target` is deprecated at generation. Generate the project once, then pick the target when you deploy:

```bash
ml-container-creator my-project --deployment-config=transformers-vllm --model-name=<hf-id> --skip-prompts
./do/deploy --target hyperpod-eks --cluster-name <cluster> --namespace <ns>
```

The flag is still accepted and seeds `DEPLOYMENT_TARGET` in `do/config`, and the interactive generator no longer asks for a target. `./do/deploy --help` lists the targets; a project can hold several active deployments and `./do/deploy --target <t>` switches focus between them. See [Deployment & Inference](deployments.md).

### Plaintext secrets are refused at deploy

`./do/deploy` exits with code 3 when `HF_TOKEN` / `NGC_API_KEY` is set with no matching `*_ARN`, before it creates anything. Store the token in Secrets Manager and deploy by reference; the container resolves the ARN at startup with the execution role:

```bash
ml-container-creator secrets create --type hf-token --name production --secret-value hf_***
mcc bootstrap add-secret hfToken <secret-arn>
./do/deploy
```

`./do/deploy --allow-plaintext-secret` is the explicit opt-out; it warns that the value is visible in SageMaker Describe APIs and CloudTrail. A plaintext `--hf-token` given at generation is also baked into the image as `ENV HF_TOKEN`. Endpoints deployed by earlier releases may still carry a plaintext token; [Secrets](secrets.md) explains how to check and rotate.

### HyperPod cluster provisioning is deprecated

`ml-container-creator bootstrap add-module hyperpod` refuses to run (without `--force`) and is hidden from the module picker. MLCC consumes an existing HyperPod cluster: create it with the AWS SageMaker console (Quick Install) or the published CloudFormation templates, then deploy with `./do/deploy --target hyperpod-eks`. Existing installs keep working and can be removed with `bootstrap remove-module hyperpod`. See [HyperPod Bootstrap](hyperpod-bootstrap.md) and [ADR-012](adr/ADR-012-consume-dont-provision-clusters.md).

### `do/train` and `do/tune` pick a compute backend

Both scripts take `--backend smtj|hp-eks`. The default is `smtj` (a SageMaker training job) on every target. On a `hyperpod-eks` project, `--backend hp-eks` runs the job as a HyperPodPyTorchJob on the cluster. Before v2, `do/train` on a `hyperpod-eks` project submitted a Kubernetes Job that never ran; that path is gone. See [Custom Training](custom-training.md#hyperpod-eks-backend-backend-hp-eks) and [Fine-Tuning](fine-tuning.md#running-on-hyperpod-eks-backend-hp-eks).

### JumpStart model IDs are refused

`jumpstart://` (and `jumpstart-hub://`) model names stop generation with a message naming the Hugging Face ID to use instead. Use a Hugging Face model ID, an `s3://` artifact, or a `registry://` model package.

## New in v2

### Three verbs for adding a model to a live deployment

The artifact kind picks the verb, and the target picks the load mechanism ([ADR-013](adr/ADR-013-additive-deploy-artifact-kind-contract.md)): `./do/adapter` for LoRA adapters on every LoRA target, `./do/add-ic` for a full model on `realtime-inference`, and the new `./do/add-pod` for a full model on `hyperpod-eks` (a second InferenceEndpointConfig). All three take the same `--from-tune`, `--from-train`, `--from-weights <s3-uri>` and `--from-registry <arn>` sources. The verb × target matrix is in [Adding models to a live deployment](deployments.md#adding-models-to-a-live-deployment).

### Serving metrics: `do/metrics`

`./do/metrics` prints server-side TTFT and end-to-end latency, queue, KV-cache, GPU utilization and (on `realtime-inference`) per-copy concurrency for the last N minutes, plus a pointer to the native dashboard. See [Benchmarking](benchmarking.md#live-readout-dometrics).

### Scale-to-zero (opt-in)

Real-time endpoints backed by inference components can scale to zero instances when idle: `./do/deploy --scale-to-zero on`. Requests fail while the endpoint wakes, so it is not for interactive SLAs. Other targets refuse the flag with the reason. See [Scale-to-Zero](scale-to-zero.md).

### HyperPod pod-slot capacity check

Before applying on `hyperpod-eks`, `./do/deploy` checks each node of the instance type for free GPUs and free pod slots (one for the serving pod, plus one for its Mountpoint-S3 pod when the model comes from S3). A first deploy stops before applying when no node has a free pod slot; a GPU shortage alone only warns. See [Troubleshooting](TROUBLESHOOTING.md#hyperpod-eks-deploy-stops-with-no-node-has-a-free-pod-slot).

### Per-project MLflow experiments

With an MLflow App on the profile (the `training` module), each project logs to its own experiment named after the project, and `do/tune` and `do/train` both log there. See [Bootstrap](bootstrap.md#mlflow-training-module).
