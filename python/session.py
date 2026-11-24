"""Browser session over the original task and optical implementations."""
import base64, io, json
import numpy as np
from PIL import Image
from sim import Simulation, call
from tasks import InstrumentTask
from imaging import MicroscopeCamera

task = None
camera = None
display_sim = None


def start(name, seed=0):
    global task, camera
    task = InstrumentTask(name, seed, record_images=True)
    camera = None
    return result()


def result():
    if task is None: return call('snapshot')
    task.sim.refresh(call('snapshot'))
    return dict(**task.observe(), success=task.success, failure=task.failure,
                done=bool(task.success or task.failure or task.sim.d.time >= task.spec['seconds']))


def tick(auto):
    if task is None: return call('step', action={}, seconds=.02)
    task.sim.refresh(call('snapshot'))
    action = task.baseline_action() if auto else {}
    task.step(action)
    # Display needs only the latest exposure, not the entire episode's RGB arrays.
    if len(task.camera_frames) > 1: task.camera_frames[:] = task.camera_frames[-1:]
    return result()


def finish():
    if task is None: raise ValueError('Start a focus task first')
    task.request_finish()
    return result()


def reset():
    global task, camera, display_sim
    task = camera = display_sim = None


def specimen(asset, channel='camera', auto=False):
    global camera, display_sim
    if camera is None: camera = MicroscopeCamera(asset, seed=5483)
    if display_sim is None: display_sim = Simulation(asset)
    display_sim.refresh(call('snapshot'))
    plane = task.focus_goal if task and 'focus' in task.name else 0.
    target = task.goal if task and 'center' in task.name else (0., 0.)
    if auto and channel == 'camera' and task and task.camera_frames:
        frame = task.camera_frames[-1]['observation'].copy()
        frame['display_role'] = 'latest controller exposure'
    else:
        frame = camera.capture(display_sim, focal_plane_m=plane, target_stage_xy=target, channel=channel)
        frame['display_role'] = 'live display capture'
        frame['time_s'] = display_sim.d.time
    buffer = io.BytesIO()
    Image.fromarray(frame.pop('rgb')).save(buffer, format='JPEG', quality=93)
    frame.pop('defocus_m', None)
    frame.pop('ground_truth', None)
    frame['image'] = 'data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode()
    return frame


def rpc(payload):
    p = json.loads(payload)
    op = p.pop('op')
    value = globals()[op](**p)
    def native(x):
        if isinstance(x, np.generic): return x.item()
        if isinstance(x, np.ndarray): return x.tolist()
        raise TypeError(type(x).__name__)
    return json.dumps(value, default=native, allow_nan=False)
