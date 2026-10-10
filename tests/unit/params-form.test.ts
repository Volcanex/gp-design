// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'lit-html';
import { paramsForm } from '../../src/ui/forms/params-form';
import type { ParamsSchema, ParamValues } from '@engine';

const schema: ParamsSchema = {
  exposure: { kind: 'float', default: 0, min: -4, max: 4, step: 0.01, unit: 'EV', label: 'Exposure' },
  levels: { kind: 'int', default: 8, min: 2, max: 256, label: 'Levels' },
  invert: { kind: 'bool', default: false, label: 'Invert' },
  mode: { kind: 'enum', default: 'a', options: ['a', 'b', 'c'], label: 'Mode' },
  offset: { kind: 'vec3', default: [0, 0, 0], label: 'Offset' },
  tint: { kind: 'color', default: [0.6, 0.1, -0.05, 1], space: 'oklab', label: 'Tint' },
  lut: { kind: 'asset', assetType: 'lut', label: 'LUT' },
  wobble: {
    kind: 'float', default: 0.5, min: 0, max: 1, step: 0.01, animatable: true, label: 'Wobble',
  },
};

function mount(values: ParamValues, onChange: (key: string, value: unknown) => void) {
  const container = document.createElement('div');
  render(paramsForm(schema, values, onChange), container);
  return container;
}

describe('paramsForm: asset picker (opts.assets)', () => {
  afterEach(() => {
    document.body.querySelectorAll('[data-testid="asset-popover"]').forEach((el) => el.remove());
  });

  function mountWithOpts(values: ParamValues, opts: NonNullable<Parameters<typeof paramsForm>[3]>) {
    const container = document.createElement('div');
    render(paramsForm(schema, values, vi.fn(), opts), container);
    return container;
  }

  it('falls back to the disabled Phase-2 button when opts.assets is omitted', () => {
    const container = mount({}, vi.fn());
    const btn = container.querySelector('[data-testid="pf-asset-lut"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('renders an enabled button showing the current asset\'s label when opts.assets is supplied', () => {
    const list = vi.fn().mockReturnValue([{ id: 'lut-1', label: 'My LUT' }]);
    const importNew = vi.fn().mockResolvedValue(null);
    const container = mountWithOpts({ lut: { asset: 'lut-1' as never } }, { assets: { list, importNew } });

    const btn = container.querySelector('[data-testid="pf-asset-lut"]') as HTMLButtonElement;
    expect(btn.disabled).toBeFalsy();
    expect(btn.textContent?.trim()).toBe('My LUT');
  });

  it('shows "Choose…" when no asset is selected yet', () => {
    const list = vi.fn().mockReturnValue([]);
    const importNew = vi.fn().mockResolvedValue(null);
    const container = mountWithOpts({}, { assets: { list, importNew } });

    const btn = container.querySelector('[data-testid="pf-asset-lut"]') as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe('Choose…');
  });

  it('clicking the button opens a popover listing every asset of that type plus an Import row', () => {
    const list = vi.fn().mockReturnValue([{ id: 'lut-1', label: 'LUT One' }, { id: 'lut-2', label: 'LUT Two' }]);
    const importNew = vi.fn().mockResolvedValue(null);
    const container = mountWithOpts({}, { assets: { list, importNew } });

    (container.querySelector('[data-testid="pf-asset-lut"]') as HTMLButtonElement).click();

    expect(list).toHaveBeenCalledWith('lut');
    expect(document.querySelector('[data-testid="asset-option-lut-1"]')?.textContent).toBe('LUT One');
    expect(document.querySelector('[data-testid="asset-option-lut-2"]')?.textContent).toBe('LUT Two');
    expect(document.querySelector('[data-testid="asset-option-import"]')).toBeTruthy();
  });

  it('choosing a listed asset calls onChange with an {asset} ref', () => {
    const list = vi.fn().mockReturnValue([{ id: 'lut-1', label: 'LUT One' }]);
    const importNew = vi.fn().mockResolvedValue(null);
    const onChange = vi.fn();
    const container = document.createElement('div');
    render(paramsForm(schema, {}, onChange, { assets: { list, importNew } }), container);

    (container.querySelector('[data-testid="pf-asset-lut"]') as HTMLButtonElement).click();
    (document.querySelector('[data-testid="asset-option-lut-1"]') as HTMLButtonElement).click();

    expect(onChange).toHaveBeenCalledWith('lut', { asset: 'lut-1' });
  });

  it('clicking Import calls importNew and, on success, onChange with the returned ref', async () => {
    const list = vi.fn().mockReturnValue([]);
    const importNew = vi.fn().mockResolvedValue({ asset: 'new-asset' });
    const onChange = vi.fn();
    const container = document.createElement('div');
    render(paramsForm(schema, {}, onChange, { assets: { list, importNew } }), container);

    (container.querySelector('[data-testid="pf-asset-lut"]') as HTMLButtonElement).click();
    (document.querySelector('[data-testid="asset-option-import"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

    expect(importNew).toHaveBeenCalledWith('lut');
    expect(onChange).toHaveBeenCalledWith('lut', { asset: 'new-asset' });
  });

  it('a cancelled Import (importNew resolves null) does not call onChange', async () => {
    const list = vi.fn().mockReturnValue([]);
    const importNew = vi.fn().mockResolvedValue(null);
    const onChange = vi.fn();
    const container = document.createElement('div');
    render(paramsForm(schema, {}, onChange, { assets: { list, importNew } }), container);

    (container.querySelector('[data-testid="pf-asset-lut"]') as HTMLButtonElement).click();
    (document.querySelector('[data-testid="asset-option-import"]') as HTMLButtonElement).click();
    await importNew.mock.results[0]!.value;

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('paramsForm', () => {
  it('renders every ParamSpec kind with the right control types and counts', () => {
    const container = mount({}, vi.fn());

    expect(container.querySelectorAll('[data-testid^="pf-row-"]').length).toBe(8);

    const exposureSlider = container.querySelector('[data-testid="pf-slider-exposure"]') as HTMLInputElement;
    expect(exposureSlider).toBeTruthy();
    expect(exposureSlider.min).toBe('-4');
    expect(exposureSlider.max).toBe('4');
    expect(exposureSlider.step).toBe('0.01');
    expect(container.querySelector('[data-testid="pf-number-exposure"]')).toBeTruthy();
    expect(container.querySelector('.gd-form-unit')?.textContent).toBe('EV');

    const levelsSlider = container.querySelector('[data-testid="pf-slider-levels"]') as HTMLInputElement;
    expect(levelsSlider.step).toBe('1');

    expect(container.querySelector('[data-testid="pf-checkbox-invert"]')).toBeTruthy();

    const select = container.querySelector('[data-testid="pf-select-mode"]') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.querySelectorAll('option').length).toBe(3);

    expect(container.querySelectorAll('[data-testid^="pf-vec-offset-"]').length).toBe(3);

    expect(container.querySelector('[data-testid="pf-swatch-tint"]')).toBeTruthy();

    const assetBtn = container.querySelector('[data-testid="pf-asset-lut"]') as HTMLButtonElement;
    expect(assetBtn).toBeTruthy();
    expect(assetBtn.disabled).toBe(true);
    expect(assetBtn.title).toBe('Change it from the Effects pane');
  });

  it('fires onChange with a coerced number for the float slider', () => {
    const onChange = vi.fn();
    const container = mount({}, onChange);
    const slider = container.querySelector('[data-testid="pf-slider-exposure"]') as HTMLInputElement;
    slider.value = '2.5';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('exposure', 2.5);
  });

  it('fires onChange with a boolean for the checkbox', () => {
    const onChange = vi.fn();
    const container = mount({}, onChange);
    const checkbox = container.querySelector('[data-testid="pf-checkbox-invert"]') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('invert', true);
  });

  it('fires onChange with the selected string for the enum select', () => {
    const onChange = vi.fn();
    const container = mount({}, onChange);
    const select = container.querySelector('[data-testid="pf-select-mode"]') as HTMLSelectElement;
    select.value = 'b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('mode', 'b');
  });

  it('fires onChange with a full vec3 array when one component changes', () => {
    const onChange = vi.fn();
    const container = mount({}, onChange);
    const comp1 = container.querySelector('[data-testid="pf-vec-offset-1"]') as HTMLInputElement;
    comp1.value = '0.75';
    comp1.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('offset', [0, 0.75, 0]);
  });

  it('renders a keyframe indicator when the current value is a track', () => {
    const container = mount({ wobble: { track: [{ t: 0, v: 0.2 }] } }, vi.fn());
    expect(container.querySelector('[data-testid="pf-keyframe"]')).toBeTruthy();
    const number = container.querySelector('[data-testid="pf-number-wobble"]') as HTMLInputElement;
    expect(number.value).toBe('0.2');
  });
});

describe('paramsForm diamond (opts.time) behaviours', () => {
  function mountWithOpts(values: ParamValues, onChange: (key: string, value: unknown) => void, opts: { time?: number; onSetKey?: (key: string, track: unknown) => void }) {
    const container = document.createElement('div');
    render(paramsForm(schema, values, onChange, opts), container);
    return container;
  }

  it('no opts -> exact current behaviour: static badge, no click handler, editing collapses', () => {
    const onChange = vi.fn();
    const container = mount({ wobble: { track: [{ t: 0, v: 0.2 }] } }, onChange);
    const badge = container.querySelector('[data-testid="pf-keyframe"]')!;
    expect(badge.tagName).toBe('SPAN'); // not a button: non-interactive
    const slider = container.querySelector('[data-testid="pf-slider-wobble"]') as HTMLInputElement;
    slider.value = '0.9';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('wobble', 0.9); // collapses to a static value
  });

  it('diamond click on a non-keyframed animatable row starts a track at the playhead with the current value', () => {
    const onChange = vi.fn();
    const onSetKey = vi.fn();
    const container = mountWithOpts({ wobble: 0.6 }, onChange, { time: 2, onSetKey });
    const diamond = container.querySelector('[data-testid="pf-keyframe"]') as HTMLButtonElement;
    expect(diamond.tagName).toBe('BUTTON'); // interactive with opts present
    diamond.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('wobble', { track: [{ t: 2, v: 0.6 }] });
    expect(onSetKey).toHaveBeenCalledWith('wobble', [{ t: 2, v: 0.6 }]);
  });

  it('diamond click on an already-keyframed row inserts/replaces the key at the playhead', () => {
    const onChange = vi.fn();
    const onSetKey = vi.fn();
    const container = mountWithOpts({ wobble: { track: [{ t: 0, v: 0.2 }, { t: 4, v: 0.8 }] } }, onChange, { time: 2, onSetKey });
    const diamond = container.querySelector('[data-testid="pf-keyframe"]') as HTMLButtonElement;
    diamond.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const [, value] = onChange.mock.calls[0]!;
    expect((value as { track: { t: number }[] }).track.map((k) => k.t)).toEqual([0, 2, 4]);
    expect(onSetKey).toHaveBeenCalled();
  });

  it('editing a keyframed row\'s value WITH opts.time updates the key at the playhead instead of collapsing', () => {
    const onChange = vi.fn();
    const container = mountWithOpts({ wobble: { track: [{ t: 0, v: 0.2 }, { t: 4, v: 0.8 }] } }, onChange, { time: 2 });
    const slider = container.querySelector('[data-testid="pf-slider-wobble"]') as HTMLInputElement;
    slider.value = '0.5';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('wobble', {
      track: [{ t: 0, v: 0.2 }, { t: 2, v: 0.5 }, { t: 4, v: 0.8 }],
    });
  });

  it('alt+click on the diamond collapses a keyframed row back to a static value, without calling onSetKey', () => {
    const onChange = vi.fn();
    const onSetKey = vi.fn();
    const container = mountWithOpts({ wobble: { track: [{ t: 0, v: 0.2 }, { t: 4, v: 0.8 }] } }, onChange, { time: 2, onSetKey });
    const diamond = container.querySelector('[data-testid="pf-keyframe"]') as HTMLButtonElement;
    diamond.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    // resolved-at-time(t=2) between (0,0.2) and (4,0.8) linearly -> 0.5
    expect(onChange).toHaveBeenCalledWith('wobble', 0.5);
    expect(onSetKey).not.toHaveBeenCalled();
  });

  it('a non-animatable row never renders an interactive diamond even with opts.time set', () => {
    const container = mountWithOpts({}, vi.fn(), { time: 1 });
    expect(container.querySelector('[data-testid="pf-row-exposure"] [data-testid="pf-keyframe"]')).toBeFalsy();
  });
});
