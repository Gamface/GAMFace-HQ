param([string]$LogDir = "$env:LOCALAPPDATA\Comfy-Desktop\hq-logs")
# Starts the Comfy Desktop install headless (hidden, detached) on 127.0.0.1:8188 for Mission Control.
#
# hipBLASLt is switched off. On the RX 9060 XT (gfx1200) with ROCm 7.14 / torch 2.12 on Windows,
# it crashes (access violation in hipblasLtMatmulAlgoGetHeuristic) on every float32 matmul and on
# small fp16 attention, which every text encoder hits. Both switches are needed: PyTorch calls
# hipBLASLt directly for some matmuls (TORCH_BLAS_PREFER_HIPBLASLT) and through rocBLAS for the
# rest (ROCBLAS_USE_HIPBLASLT). Then rocBLAS uses its own kernels: everything works, matmuls are
# ~10x slower (about 95 s per 1024x1024 Z-Image Turbo picture). PyTorch's preferred_blas_library
# switch isn't supported on Windows, and the fast attention kernels (flash/efficient) aren't in
# this build. Retest after a ComfyUI update.
#
# The scheduled task runs a copy of this script from %LOCALAPPDATA%\Comfy-Desktop\start-comfy-hq.ps1
# (WSL may not be running at login): copy it again after changing it.
$install = "$env:LOCALAPPDATA\Comfy-Desktop\ComfyUI-Installs\GAMFace"
$shared  = "$env:LOCALAPPDATA\Comfy-Desktop\ComfyUI-Shared"
$paths   = (Get-ChildItem "$env:APPDATA\Comfy Desktop\instance-model-paths" -Filter *.yaml | Select-Object -First 1).FullName
New-Item -ItemType Directory -Force $LogDir | Out-Null
$env:ROCBLAS_USE_HIPBLASLT = '0'
$env:TORCH_BLAS_PREFER_HIPBLASLT = '0'
# Already running? Don't start a second copy on the same port
try { Invoke-RestMethod http://127.0.0.1:8188/system_stats -TimeoutSec 2 | Out-Null; "ComfyUI is already running on 127.0.0.1:8188"; return } catch {}
$argList = @('-s', 'ComfyUI\main.py', '--listen', '127.0.0.1', '--port', '8188',
  '--extra-model-paths-config', "`"$paths`"",
  '--input-directory', "`"$shared\input`"", '--output-directory', "`"$shared\output`"",
  '--disable-auto-launch')
$p = Start-Process -FilePath "$install\ComfyUI\.venv\Scripts\python.exe" -ArgumentList $argList -WorkingDirectory $install `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput "$LogDir\comfy.out.log" -RedirectStandardError "$LogDir\comfy.err.log"
"ComfyUI started, process $($p.Id), logs in $LogDir"
