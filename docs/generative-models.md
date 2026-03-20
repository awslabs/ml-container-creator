For the purposes of ML Container Creator, the term "generative" model refers to foundation models created with billions of parameters. These models are not trained by users on commodity hardware, and are more than likely not stored in local storage. These are foundation models or LLMs. When using MCC to package and deploy LLMs, the following serving frameworks are currently supported:

--8<-- "ai-frameworks-table.md"

MCC does not require the selection of a model format for generative models. Generative models are not deployed locally, they must be specified at generation time by model ID. The models are downloaded from a model hub and loaded into the selected model server. MCC defers model downloading and loading into GPU memory to the model serving framework. Users specify the model ID in the model name field of the request:

```json
{
  "framework": "transformers",
  "modelName": "mistralai/Mistral-7B-Instruct-v0.2",
  "modelServer": "sglang"
}
```
There are several ways to do this, but the generator only supports the loading of an LLM by model ID if the appropriate model serving framework is selected by the user. The table above specifies the full list of supported LLM serving frameworks.

## Loading Models
Model files are loaded into containers through various means. Users select from several model loading strategies. The selected option influences how files assets like the Dockerfile are generated. Ultimately, generated files can be modified and extended extensively by users to accommodate any model loading pattern that a user wants to implement. 

### HuggingFace Model Hub
HuggingFace is the default model hub for selecting models. By specifying a model ID, MCC will attempt to download the model from HuggingFace by default. 

#### HF_TOKEN
Some HuggingFace models are gated, requiring a HuggingFace API Token to access them. There are several ways to specify your HuggingFace Token for MCC:

1. CLI Flag (highest precedence)
```bash
yo @aws/ml-container-creator \
  --framework=transformers \
  --model-name="meta-llama/Llama-2-7b-chat-hf" \
  --hf-token="hf_your_token_here"
```
2. Environment Variable 
```bash
export HF_TOKEN="hf_your_token_here"
yo @aws/ml-container-creator \
  --framework=transformers \
  --model-name="meta-llama/Llama-2-7b-chat-hf" \
  --hf-token='$HF_TOKEN'
```
3. Interactive Prompt (Yeoman REPL)
```bash
yo @aws/ml-container-creator
# When prompted for transformers, you'll be asked for HF token
# Enter: $HF_TOKEN (to use env var) or hf_your_token_here (direct)
```
4. Config File
There are several ways to configure MCC, this snippet is generally the approach regardless of the configuration file. See the [Configuration Guide](configuration.md) for more details.
```json
{
  "framework": "transformers",
  "modelName": "meta-llama/Llama-2-7b-chat-hf",
  "hfToken": "$HF_TOKEN"
}
```

#### HuggingFace API Calls
When a HuggingFace model ID is specified, MCC attempts to validate the model's existence using HuggingFace API lookups, querying HuggingFace endpoints for model meta-data: 

* Model Metadata - GET /api/models/{modelId}
    * Validates model exists
    * Gets model info (tags, downloads, etc.)
* Tokenizer Config - GET /{modelId}/resolve/main/tokenizer_config.json
    * Extracts chat template
    * Used for chat-based models
* Model Config - GET /{modelId}/resolve/main/config.json
    * Gets model architecture details
    * Model type, hidden size, etc.

The MCC HuggingFaceClient object automatically handles `404` and `429` errors and times out after 5 seconds. 

In scenarios where users are using MCC without access to the Internet, users may circumvent HuggingFace API calls by passing the `--offline` flag at generation time. Specifying this flag speeds up generation times by removing the additional Internet lookup.

##### Amazon SageMaker JumpStart Model Hub
!!! todo "Under Construction"
    This feature is roadmapped, but currently not supported.

##### Amazon SageMaker Model Registry
!!! todo "Under Construction"
    This feature is roadmapped, but currently not supported.