# Deferred OCR research

Research and scope decision recorded on 2026-10-20.

## Current decision

Do not implement OCR or a dedicated scanned-document workflow. Do not add PaddleOCR, MinerU, another transcription model, a hosted OCR API, or OCR preferences to ChatPDF. These findings are retained for reference, not as an active integration plan.

PDFs with a usable text layer use the existing local PDF.js extraction or a fresh Zotero index for search and navigation. Substantive reading uses original PDF page images with the configured vision-capable chat model. Missing extractable text is a search-coverage limitation, not evidence that a page is blank. Rendering an image-only page does not create a searchable text layer.

The removed PDF-to-Markdown pipeline stays removed. See [Direct PDF reading](direct-pdf-reading.md) and [Project status](project-status.md).

## PaddleOCR-VL-1.6 size and deployment

- The official model name describes approximately 0.9 billion parameters. This is a parameter count, not a download size.
- The official Hugging Face repository lists a **1.92 GB BF16 weight file** and approximately **1.93 GB** for the model repository. Runtime dependencies and additional pipeline components are separate. [Model files](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6/tree/main)
- Runtime memory also includes intermediate tensors, image processing and generation caches; it varies with backend, resolution and concurrency. The official FastDeploy guide for the earlier **PaddleOCR-VL-0.9B** recommends **8 GB or more VRAM**. This is a deployment reference for that version/backend, not a measured minimum for 1.6. [FastDeploy guide](https://github.com/PaddlePaddle/FastDeploy/blob/develop/docs/zh/best_practices/PaddleOCR-VL-0.9B.md)
- Local inference requires downloaded weights and a compatible runtime, but no hosted-service API key. The full PaddleOCR pipeline supports page parsing; its plain Transformers example covers element recognition/text spotting rather than the complete page pipeline. [Model card](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6)

No model was downloaded, installed or benchmarked as part of this research.

## Formula recognition evidence

The authors' technical report gives the following Formula-CDM scores on **OmniDocBench v1.6**:

| Model | Formula-CDM |
| --- | ---: |
| PaddleOCR-VL-1.6 | 97.49 |
| MinerU2.5-Pro, comparison only | 97.45 |
| GLM-OCR, 0.9B | 97.18 |
| PaddleOCR-VL-1.5 | 96.89 |

Source: [PaddleOCR-VL-1.6 technical report, Table 2](https://arxiv.org/html/2606.03264v1). These are reported benchmark results, not measurements on the user's papers or an independent reproduction. Small score differences do not establish a reliable ranking for a particular mathematical corpus.

CDM renders predicted and reference LaTeX, then matches characters and their spatial positions. A score of 97.49 does **not** mean that 97.49% of complete formulas are exactly correct. It also does not verify mathematical equivalence or reasoning. A renderable formula can still contain an incorrect sign, subscript or vector style. [CDM paper](https://openaccess.thecvf.com/content/CVPR2025/html/Wang_Image_Over_Text_Transforming_Formula_Recognition_Evaluation_with_Character_Detection_CVPR_2025_paper.html)

Consequently, these results do not justify replacing original-page evidence with OCR output.

## Hosted access: free use and authentication are separate

| Service | Findings at review time | Integration implication |
| --- | --- | --- |
| [PaddleOCR official API](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/serving/paddleocr_official_api/cli.html) | Supports PaddleOCR-VL-1.6; requires an AI Studio access token. The official service documents free quotas and quota-increase applications. [Quota rules](https://ai.baidu.com/ai-doc/AISTUDIO/Xmjclapam) | A candidate if free authenticated access is acceptable. It does not meet a strict no-key requirement. |
| [PaddleOCR official HF demo](https://huggingface.co/spaces/PaddlePaddle/PaddleOCR-VL-1.6_Online_Demo) | Public demonstration; its app warns that the demo can be slow and points users to the official API. | Suitable for small manual comparisons; continuous API availability was not tested. |
| [LightOnOCR-3 official demo](https://huggingface.co/spaces/lightonai/LightOnOCR-3-Demo) | Public demonstration of another OCR family, with 0.8B, 1B and 4B variants. [Model card](https://huggingface.co/lightonai/LightOnOCR-3-1B) | A comparison candidate. The reviewed evidence does not establish better formula recognition than PaddleOCR-VL-1.6. |
| [HF Inference Providers](https://huggingface.co/docs/inference-providers/pricing) | The pricing page lists no included monthly credits for free accounts. The PaddleOCR-VL-1.6 model card lists no deployed Inference Provider. | Free model downloads do not imply a free hosted inference endpoint. |

Public Gradio Spaces can expose anonymous API access, subject to the individual app and platform limits. HF currently documents daily ZeroGPU quotas of two GPU minutes for unauthenticated access and five for a free account; unauthenticated requests use a shared pool. These quotas concern ZeroGPU Spaces, not every demo or the PaddleOCR official API. [Spaces API documentation](https://huggingface.co/docs/hub/spaces-api-endpoints)

No service was verified to simultaneously provide better formula recognition, free usage, no credentials and dependable continuous public API access. Online inference, account-specific quotas, latency and sustained availability were not tested. Service terms and quotas can change.

## Other local candidates retained for reference

| Candidate | Possible role if OCR is reconsidered | Limitations |
| --- | --- | --- |
| [Granite-Docling 258M](https://huggingface.co/ibm-granite/granite-docling-258M) | Small document parsing model producing DocTags | The reviewed model card lists English and CPU/CUDA examples. It is a Docling component, not a general reasoning model. |
| [Tesseract](https://github.com/tesseract-ocr/tesseract/blob/main/README.md) | Plain keyword indexing | Needs page rasterization and language data; not a replacement for mathematical page interpretation. |

None of these candidates is installed, called or scheduled for implementation by this decision. If OCR is reconsidered later, evaluate it on representative pages and retain original page images as the evidence source.
