import type { KeyboardEvent } from 'react';

interface TabBarProps<T extends string> {
  id: string;
  label: string;
  items: readonly { id: T; label: string }[];
  active: T;
  onChange: (value: T) => void;
  className: string;
  sharedPanel?: boolean;
}

export function TabBar<T extends string>({ id, label, items, active, onChange, className, sharedPanel }: TabBarProps<T>) {
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = items.length - 1;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = index === 0 ? last : index - 1; break;
      case 'ArrowRight': next = index === last ? 0 : index + 1; break;
      case 'Home': next = 0; break;
      case 'End': next = last; break;
      default: return;
    }
    event.preventDefault();
    const tab = items[next];
    onChange(tab.id);
    document.getElementById(`${id}-${tab.id}-tab`)?.focus();
  }

  return (
    <div className={className} role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.id}
          id={`${id}-${item.id}-tab`}
          className="tab-button"
          type="button"
          role="tab"
          aria-selected={item.id === active}
          aria-controls={sharedPanel ? `${id}-panel` : `${id}-${item.id}-panel`}
          tabIndex={item.id === active ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => moveTab(event, index)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
