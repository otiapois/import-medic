import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Mode = 'repair' | 'price-diff' | 'verify' | 'promo' | 'supplier-delta' | 'migrate';
const SHELL_TOKEN = /^[A-Za-z0-9_.=-]+$/;
const WINDOWS_SHELL_LIMIT = 8191;

export function encodeCliText(value: string) {
  let bytes = '';
  for (const byte of new TextEncoder().encode(value)) bytes += String.fromCharCode(byte);
  return btoa(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function exampleSheetPath(stem: string, filename?: string) {
  return `${stem}.${filename && /\.xlsx$/i.test(filename) ? 'xlsx' : 'csv'}`;
}

export function LocalCliCommand({ mode, getArguments, unavailable, children }: {
  mode: Mode;
  getArguments: () => string[] | null;
  unavailable?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ command: string; message: string }>();
  const field = useRef<HTMLTextAreaElement>(null);
  const description = useId();
  const args = open ? getArguments() : null;
  const command = args?.every((token) => SHELL_TOKEN.test(token))
    ? ['npm', 'run', 'repair-cli', '--', '--mode', mode, ...args, '--out-dir', 'output'].join(' ')
    : '';

  async function copy() {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(command);
        if (field.current?.value === command) setFeedback({ command, message: 'CLI command copied.' });
        return;
      }
    } catch {
      // Clipboard access can be unavailable in browser or permission-restricted sessions.
    }
    if (field.current?.value !== command) return;
    field.current.focus({ preventScroll: true });
    field.current.select();
    setFeedback({ command, message: 'Command selected. Use your device’s copy command.' });
  }

  return (
    <details className="local-cli-command" onToggle={(event) => {
      setOpen(event.currentTarget.open);
      if (!event.currentTarget.open) setFeedback(undefined);
    }}>
      <summary>Local CLI Command</summary>
      {open ? (
        <div className="local-cli-body">
          {children}
          {command ? (
            <>
              <p className="field-help" id={description}>
                Run from your ImportMedic checkout with its dependencies installed. Use the npm bundled with a supported Node.js release. Replace the example input filenames with your local files and choose a fresh output directory.
              </p>
              {command.length > WINDOWS_SHELL_LIMIT ? (
                <p className="field-help">This command exceeds the Windows npm launcher’s length limit. Run it in an environment that accepts longer commands.</p>
              ) : null}
              <textarea ref={field} aria-label="CLI command" aria-describedby={description}
                dir="ltr" readOnly value={command} rows={4} spellCheck={false} />
              <div className="local-cli-actions">
                <button className="button button-secondary button-small" type="button" onClick={() => void copy()}>Copy CLI Command</button>
                <span role="status">{feedback?.command === command ? feedback.message : ''}</span>
              </div>
            </>
          ) : <p className="field-help">{unavailable ?? 'Complete the current settings to prepare a command.'}</p>}
        </div>
      ) : null}
    </details>
  );
}
