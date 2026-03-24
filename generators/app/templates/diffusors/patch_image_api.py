"""
Patch vLLM-Omni image_api_utils.encode_image_base64 to handle numpy arrays.

Some diffusion models (especially video models like Wan2.1) return numpy
arrays with extra batch/frame dimensions and float32 dtype. The upstream
encode_image_base64() expects a PIL Image. This patch normalises the array
to (H, W, 3) uint8 before converting to PIL.
"""

import vllm_omni.entrypoints.openai.image_api_utils as mod

path = mod.__file__
source = open(path).read()

# Match the save() call site — resilient to function signature changes
old = "    image.save(buffer, format=\"PNG\")"
new = """\
    import numpy as np
    from PIL import Image as _PILImage
    if isinstance(image, np.ndarray):
        # Squeeze batch / frame dims: (1,1,H,W,3) or (1,H,W,3) -> (H,W,3)
        while image.ndim > 3:
            image = image[0]
        # float [0,1] -> uint8 [0,255]
        if image.dtype != np.uint8:
            image = np.clip(image * 255.0, 0, 255).astype(np.uint8)
        image = _PILImage.fromarray(image)
    image.save(buffer, format="PNG")"""

if old not in source:
    print("WARN: patch target not found — already patched or API changed")
else:
    source = source.replace(old, new, 1)
    open(path, "w").write(source)
    print(f"Patched {path}")
