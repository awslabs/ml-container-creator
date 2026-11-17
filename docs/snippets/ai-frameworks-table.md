| Framework | Base image repository |
|-----------|----------|
| [vLLM](https://docs.vllm.ai/en/latest/) | `vllm/vllm-openai` |
| [SGLang](https://github.com/sgl-project/sglang) | `lmsysorg/sglang` |
| [TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM) | `nvcr.io/nvidia/tensorrt-llm/release` |
| [LMI](https://docs.djl.ai/master/docs/serving/serving/docs/lmi/index.html) | AWS DLC `djl-inference` (LMI) |
| [DJL](https://djl.ai/) | `deepjavalibrary/djl-serving` |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | AWS DLC `llama-cpp` (SageMaker server) |
| [vLLM-Omni](https://github.com/vllm-project/vllm-omni) | `vllm/vllm-omni` (diffusors) |

The catalogued image tags and their CUDA requirements live in `servers/lib/catalogs/model-servers.json`; the base-image-picker MCP server selects a compatible tag per instance family.
