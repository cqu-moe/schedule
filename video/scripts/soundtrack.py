"""Original, deterministic 30-second instrumental score; no sampled recordings."""
from pathlib import Path
import wave
import numpy as np

rate = 44100
duration = 30
mix = np.zeros((rate * duration, 2))
rng = np.random.default_rng(42)

def note(start, seconds, midi, gain, pan=0, soft=False):
    count = min(int(seconds * rate), len(mix) - int(start * rate))
    if count <= 0:
        return
    t = np.arange(count) / rate
    hz = 440 * 2 ** ((midi - 69) / 12)
    envelope = (1 - np.exp(-t * (8 if soft else 120))) * np.exp(-t * (0.65 if soft else 3.4))
    envelope *= np.minimum(1, (seconds - t) * 6)
    signal = np.sin(2*np.pi*hz*t) + 0.22*np.sin(2*np.pi*hz*2*t) + 0.08*np.sin(2*np.pi*hz*3*t)
    signal *= envelope * gain
    stereo = np.stack([signal*np.sqrt((1-pan)/2), signal*np.sqrt((1+pan)/2)], axis=1)
    begin = int(start * rate)
    mix[begin:begin+count] += stereo
    # Quiet room reflections, generated from the same original notes.
    for delay, level in [(0.18, 0.14), (0.36, 0.08)]:
        begin = int((start+delay)*rate)
        size = min(count, len(mix)-begin)
        if size > 0:
            mix[begin:begin+size] += stereo[:size, ::-1]*level

chords = [[48,55,59,64], [45,52,55,60], [41,48,52,57], [43,50,55,59], [48,55,59,64]]
for section, chord in enumerate(chords):
    for tone in chord:
        note(section*6, 6.8, tone, 0.04, soft=True)
    for step in range(10):
        note(section*6+step*0.6, 1.5, chord[[0,2,3,1,2,3,1,3,2,1][step]]+12, 0.065, (-0.3 if step%2 else 0.3))
    for beat in range(10):
        start = section*6+beat*0.6
        t = np.arange(int(0.16*rate))/rate
        kick = np.sin(2*np.pi*(48*t+3*(1-np.exp(-t*25))))*np.exp(-t*34)*0.065
        begin = int(start*rate)
        mix[begin:begin+len(kick)] += kick[:, None]
        if beat % 2:
            tick = rng.normal(0,1,len(t))*np.exp(-t*100)*0.006
            mix[begin:begin+len(tick)] += tick[:, None]
for at in [4.5,12,18,26]:
    note(at,1.8,79,0.035,0.2)
t = np.arange(len(mix))/rate
mix *= (np.minimum(t/0.8,1)*np.minimum((duration-t)/1.8,1))[:,None]
assert np.isfinite(mix).all() and np.max(np.abs(mix)) < 0.95
pcm = (mix*32767).astype('<i2')
with wave.open(str(Path(__file__).resolve().parents[1]/'public/soundtrack.wav'),'wb') as out:
    out.setnchannels(2)
    out.setsampwidth(2)
    out.setframerate(rate)
    out.writeframes(pcm.tobytes())
print(f'{duration}s stereo score; peak {np.max(np.abs(mix)):.3f}')
