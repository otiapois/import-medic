import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export function PriceFileInput({ side, field, showTitle = true, position, file, message, onLoad, onClear, clearLabel, worksheet, children }: {
  side: string;
  field: { title: string; formats: string; label: string; accept: string };
  showTitle?: boolean;
  position?: number;
  file?: { file: File; synthetic?: boolean };
  message: { reading?: boolean; error?: string };
  onLoad: (files: FileList) => void;
  onClear?: () => void;
  clearLabel?: string;
  worksheet?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const suffix = position && position > 1 ? ` ${position}` : '';
  return (
    <div className="price-file">
      {showTitle ? <h3>{field.title}{position ? ` ${position}` : ''}</h3> : null}
      <div
        className="drop-zone"
        data-testid={`price-${side}-dropzone${position && position > 1 ? `-${position}` : ''}`}
        data-dragging={dragging}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragging(false);
          onLoad(event.dataTransfer.files);
        }}
      >
        <p id={`${id}-formats`}>{field.formats}</p>
        <div className="file-picker">
          <input
            className="sr-only"
            id={id}
            ref={input}
            type="file"
            accept={field.accept}
            aria-describedby={`${id}-formats`}
            onChange={(event) => {
              const target = event.currentTarget;
              if (target.files) onLoad(target.files);
              target.value = '';
            }}
          />
          <label className="button button-secondary" htmlFor={id}>{field.label}{suffix}</label>
        </div>
      </div>
      {file ? (
        <div className="price-file-selection">
          <div className="price-file-name">
            <p><span className="sr-only">Selected file: </span><strong>{file.file.name}</strong>{file.synthetic ? <small>Synthetic file</small> : null}</p>
            {onClear ? <button className="text-button" type="button" onClick={() => { onClear(); input.current?.focus(); }}>{clearLabel ?? `Clear ${side} file`}</button> : null}
          </div>
          {worksheet}
        </div>
      ) : null}
      <p className={message.reading ? 'file-message' : 'sr-only'} role="status">{message.reading ? 'Reading file…' : file ? `${field.title} selected.` : ''}</p>
      {message.error ? <p className="file-message file-error" role="alert">{message.error}</p> : null}
      {children}
    </div>
  );
}
