# How It Works

This guide describes how ML Container Creator (MCC) works. This document is a deeper guide meant for users interested in leveraging MCC for effectively. If you're just getting started, please check out the [Getting Started Guide](getting-started.md), or the [AWS OSS Launch Blog for ml-container-creator](https://aws.amazon.com/blogs/opensource/announcing-ml-container-creator-for-easy-byoc-on-sagemaker/) before proceeding. 

## Problem Statement
The explosion of models, architectures, and ways to serve AI models has made it harder to identify a path forward when deploying a model. Deploying a model can itself become challenging, as engineers copy/paste sample code that works here, but not there. The rationale for decisions made for or against a configuration option are difficult to propogate throughout an organization, necessitating a standardized mechanism for deploying models.

There will likely never be a shortage of models to use. However, as the AI/ML space coalesces around frameworks, techniques, and deployment options, it becomes easier for tooling to address the complexity of decisions that must be made in the course of deployment. 

## MCC Solution
MCC is built to assist customers in standardizing and simplifying the  technical assets associated with the three decisions made in the course of deploying a model:

1. Model Selection - Where does the model come from?
2. Model Serving - How will it serve inference requests?
3. Model Deployment - What infrastructure will this run on?

While these decisions seem independent, they become interrelated as you consider approaches to containerizing and customizing models. Moreover, each decision is an inflexion point that influences the technical assets used in deployment, such as Dockerfiles or start-up scripts for serving. 

MCC provides users with a standard interface for building and deploying these technical assets. This is accomplished using templated assets that accommodate a growing list of options. Actions can be taken using standardized `do/` scripts inspired by the [do-framework](https://github.com/iankoulski/do-framework). MCC adapts the do-framework conventions into a `do/` subdirectory with scripts like `build`, `push`, `run`, `test`, `deploy`, `clean`, `logs`, and `export`, and extends the pattern with AWS-specific lifecycle commands for SageMaker deployment.

MCC started as a [Yeoman Generator](https://yeoman.io/), allowing users to generate containerized deployment assets using a decision-tree style REPL. This is an easy way to understand the generation flow, though not the only way to interact with MCC. Users can automate the generation of these assets using a CLI configured by environment variables, CLI flags, and configuration files.

--8<-- "generator-flow-section.md"

## Architecture

The following diagram illustrates the complete flow from model selection through deployment.
!!! todo "Coming Soon"
    Features marked with an asterisk(*) are not currently supported, but are coming soon.

--8<-- "architecture-diagram.md"

#### Key Architectural Differences: Predictive ML vs Generative AI
MCC is built to deploy models to [Amazon SageMaker AI Managed Inference endpoints](https://aws.amazon.com/sagemaker/ai/deploy/). As such, MCC-built containers must support the two required HTTP endpoints for a SageMaker AI Managed Inference endpoint, `/ping` and `/invocations`, on port 8080 of the serving endpoint. To support predictive models built using regression or classification techniques, small models with thousands of parameters or less, are built and packed directly into the container and served with an HTTP server inside the container. These servers are configured to respond to HTTP requests on the required endpoints. Generative models are often too large to pull from Amazon S3 or to be loaded directly into the container from local disk. These large models are pulled from HuggingFace by a serving framework, which also handles HTTP requests. 

| Aspect | Predictive ML | Generative AI |
|--------|---------------|---------------|
| **Serving Architecture** | Separate layers: Model Handler (Python) + Web Server (Flask/FastAPI) + Nginx | Combined: model loading and HTTP serving is handled by the framework, with some NGINX proxy required by certain frameworks |
| **Model Storage** | Local files (.pkl, .h5) bundled in container, small size (MB). Amaozn S3* or SageMaker Model Registry* | HuggingFace Hub, downloaded at runtime, large size (GB) |
| **Instance Types** | CPU-optimized (ml.m5.x) | GPU-required (ml.g5.x) |
| **Inference** | Fast (milliseconds), batch-friendly, structured input/output | Slower (seconds), streaming responses, text generation |

### Incorporating a Model

Users must provide MCC a model to be deployed within the container assets. Failure to provide a model to MCC at generation time will result in unpredictable behavior which is dependent on the selected framework. 

MCC is built to support the containerization of specific model assets which are built using specific model training frameworks. Models are deployed directly into the container definition using Dockerfile directives. Alternatively, models can be pulled from model hubs using model serving frameworks. These two approaches are treated differentely by MCC. 

For more information, review the deep dives on [predictive](predictive-models.md) and [generative](generative-models.md) models.

### ML Hosting & Serving Frameworks
MCC supports several predictive ML and generative AI frameworks for model serving. This list is evolving, check Frameworks section for more details on how to use these for advanced use cases.

For more information, check out the sections on supported [HTTP Servers](http-serving.md) and [LLM Servers](llm-serving.md).

## Container Building

MCC generates Docker containers that package everything needed to serve model inference requests over HTTP. The generated Dockerfile bundles the appropriate base image, application code (model handlers and web servers), configuration files, and dependencies. For traditional ML frameworks (scikit-learn, XGBoost, TensorFlow), model artifacts are included directly in the container. For transformer models, the container downloads models from HuggingFace Hub at runtime to keep image sizes manageable. For Triton Inference Server configurations, MCC generates the model repository structure, `config.pbtxt`, and backend-specific files.

The build process follows a standard Docker workflow managed by `do/` scripts: `./do/build` creates the image locally, `./do/push` uploads it to Amazon Elastic Container Registry (ECR), and `./do/deploy` provisions the deployment target. For CI/CD workflows, `./do/submit` handles building and pushing via AWS CodeBuild. The resulting container exposes SageMaker-compatible endpoints (`/ping` for health checks and `/invocations` for inference) on port 8080, ready for production deployment.


For more information, check out the section on [Containerization](containerization.md).

### Endpoint Deployment
Once an MCC container is built, it can be launched as a process. MCC supports two deployment targets:

- **Managed Inference** (`managed-inference`): Deploys to Amazon SageMaker AI managed inference endpoints using the Inference Components API. This is the default target and supports real-time inference.
- **HyperPod EKS** (`hyperpod-eks`): Deploys to an existing SageMaker HyperPod cluster running on Amazon EKS using Kubernetes manifests.

Both targets are managed through the `./do/deploy` script. After deployment, `./do/test` validates the endpoint, `./do/logs` tails deployment logs, and `./do/clean` tears down resources.

For more information, check out the deployment deep-dive on the [Deployment & Inference](deployments.md) page.