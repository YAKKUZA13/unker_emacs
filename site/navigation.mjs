import { createApp, h, reactive } from 'vue';
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from '@ui-sdk/vue/segmented-control';

const views = [
  { id: 'boot', label: 'Загрузка' },
  { id: 'emacs', label: 'Doom Emacs' },
  { id: 'shell', label: 'Терминал Alpine' },
];

export function mountNavigation(element, onSelect) {
  const state = reactive({ view: 'boot', disabled: true });

  createApp({
    render() {
      return h(SegmentedControl, {
        'aria-label': 'Рабочая область',
        value: state.view,
        disabled: state.disabled,
        'onUpdate:value': onSelect,
      }, () => [
        h(SegmentedControlIndicator),
        ...views.map(({ id, label }) => h(SegmentedControlItem, {
          id: `show-${id}`,
          key: id,
          value: id,
          onClick: () => {
            if (state.view === id && !state.disabled) onSelect(id);
          },
        }, () => label)),
      ]);
    },
  }).mount(element);

  return (view, enabled) => {
    state.view = view;
    state.disabled = !enabled;
  };
}
