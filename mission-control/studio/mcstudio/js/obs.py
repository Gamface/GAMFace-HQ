"""Live OBS control isn't part of Mission Control (OBS runs on Windows, the studio in a
container). Record your take in OBS yourself and use the Performance workflow with the file."""

MESSAGE = "Live OBS control isn't available in Mission Control: record in OBS yourself, then use Performance video with the recording"


def _no(*_a, **_k):
    raise RuntimeError(MESSAGE)


start = record = set_scene = setup_camera_scene = status = stop = _no
