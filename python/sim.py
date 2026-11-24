"""Python task adapter for the JS MuJoCo worker, with explicit snapshot copies.

The inner 1 kHz physics loop stays in physics.js. Existing task policies and
optical image formation run unchanged in Pyodide. Only reset uses writeback.
"""
import json, sys, types
from types import SimpleNamespace as NS
import numpy as np
from js import physics_bridge


def call(op, **kwargs):
    return json.loads(physics_bridge(op, json.dumps(kwargs)))


class Model:
    def __init__(self, info):
        self.info = info

    def _get(self, kind, name):
        value = self.info[kind][name] if isinstance(name, str) else list(self.info[kind].values())[int(name)]
        return NS(**{k: np.array(v) if isinstance(v, list) else v for k, v in value.items()})

    def joint(self, name): return self._get('joints', name)
    def body(self, name): return self._get('bodies', name)
    def geom(self, name): return self._get('geoms', name)


class Data:
    def __init__(self, sim): self.sim = sim
    def site(self, name):
        i = self.sim.info['sites'][name]['id']
        return NS(xpos=np.array(self.sim.latest['sites'][name]), xmat=self.site_xmat[i])


class Simulation:
    def __init__(self, asset, fixtures=True):
        if not fixtures: raise ValueError('The browser operates the explicit bench fixtures')
        self.info = call('metadata')
        if asset != self.info['asset']: raise ValueError('Load the requested instrument first')
        self.asset = asset
        self.meta = self.info['meta']
        self.m = Model(self.info)
        self.d = Data(self)
        self.controller = NS(objective=lambda: self.latest['objective']) if asset == 'nikon' else None
        self.refresh(call('snapshot'))

    def refresh(self, state):
        self.latest = state
        self.d.time = state['time']
        for key, value in state['arrays'].items():
            a = np.array(value)
            if key in ('xpos',): a = a.reshape(-1, 3)
            if key in ('xmat', 'site_xmat'): a = a.reshape(-1, 9)
            setattr(self.d, key, a)
        self.d.warning = NS(number=np.array(state['warnings']))
        self.targets = state['targets'].copy()
        self.mocap_target = np.array(state['mocap_target'])
        self.mocap_quat_target = np.array(state['mocap_quat_target'])
        self.guard_events = state['guard_events']

    def reset(self, seed=0):
        self.rng = np.random.default_rng(seed)
        self.refresh(call('reset'))
        return self.observe()

    def q(self, name): return float(self.d.qpos[self.m.joint(name).qposadr[0]])
    def site(self, name): return np.array(self.latest['sites'][name])
    def contact_info(self): return self.latest['contacts']
    def poses(self): return self.latest['poses']
    def observe(self): return {k: v for k, v in self.latest.items() if k not in ('arrays', 'targets', 'mocap_target', 'mocap_quat_target')}
    def step(self, action=None, seconds=.02):
        self.refresh(call('step', action=action or {}, seconds=seconds))
        return self.observe()
    def command(self, action): return call('command', action=action)


def forward(model, data):
    sim = data.sim
    sim.refresh(call('applyReset', qpos=data.qpos.tolist(), targets=sim.targets))


# The unchanged task reset calls only mj_forward. All dynamics are real MuJoCo
# WASM; this narrowly scoped adapter is not a Python physics implementation.
module = types.ModuleType('mujoco')
module.mj_forward = forward
sys.modules['mujoco'] = module
