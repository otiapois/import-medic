import { useLayoutEffect, useRef } from 'react';

type ShortcutsDialogProps = {
  priceStudio: boolean;
  characterKeys: boolean;
  onChangeCharacterKeys: (enabled: boolean) => void;
  onClose: () => void;
};

export default function ShortcutsDialog({ priceStudio, characterKeys, onChangeCharacterKeys, onClose }: ShortcutsDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const setting = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    dialog.current?.showModal();
    close.current?.focus();
  }, []);

  function dismiss() {
    dialog.current?.close();
    onClose();
  }

  return (
    <dialog ref={dialog} className="shortcuts-dialog" aria-labelledby="shortcuts-heading" data-testid="shortcuts-dialog"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
        const first = event.shiftKey ? setting.current : close.current;
        const last = event.shiftKey ? close.current : setting.current;
        if (event.target !== last) return;
        event.preventDefault();
        first?.focus();
      }}>
      <header>
        <h2 id="shortcuts-heading">Keyboard shortcuts</h2>
        <button ref={close} type="button" className="button button-secondary button-small" data-testid="shortcuts-close"
          onClick={dismiss}>Close</button>
      </header>
      <dl className="shortcuts-list">
        <div><dt><kbd>?</kbd></dt><dd>Open this dialog from outside a form field.</dd></div>
        <div><dt><kbd>/</kbd></dt><dd>{priceStudio ? 'Focus row search in Build Update when it is available.' : 'Focus row search when it is available in Price Update Studio.'}</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close this dialog{priceStudio ? ' or cancel a price row edit' : ''} and return focus to the originating control.</dd></div>
      </dl>
      <label className="checkbox-label shortcuts-setting">
        <input ref={setting} type="checkbox" data-testid="shortcuts-single-character" checked={characterKeys}
          onChange={(event) => onChangeCharacterKeys(event.currentTarget.checked)} />
        <span>Enable single-character shortcuts on this page</span>
      </label>
    </dialog>
  );
}
