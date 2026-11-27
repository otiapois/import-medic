import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SIGNOFF_ACCENTS, signoffBrandSchema } from '../../core/branding/signoff-brand';
import type { SignoffBrand } from '../../core/branding/signoff-brand';
import { readWorkspaceProfileFile } from './workspaceProfileFile';

const EMPTY_BRAND: SignoffBrand = { agencyName: '', preparedFor: '', contactNote: '', accentKey: 'forest' };
const ACCENTS = Object.keys(SIGNOFF_ACCENTS) as SignoffBrand['accentKey'][];

interface BrandingState {
  draft: SignoffBrand;
  valid: boolean;
  branding?: SignoffBrand;
}

const BrandContext = createContext<BrandingState & {
  editBranding: (draft: SignoffBrand) => void;
  restoreBranding: (branding?: SignoffBrand) => void;
} | null>(null);

export function SignoffBrandingProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BrandingState>({ draft: EMPTY_BRAND, valid: false });
  return (
    <BrandContext.Provider value={{
      ...state,
      editBranding(draft) {
        const result = signoffBrandSchema.safeParse(draft);
        setState((previous) => ({ draft, valid: result.success, branding: result.success ? result.data : previous.branding }));
      },
      restoreBranding(branding) {
        setState({ draft: branding ?? EMPTY_BRAND, valid: Boolean(branding), branding });
      },
    }}>
      {children}
    </BrandContext.Provider>
  );
}

export function useSignoffBranding() {
  return useContext(BrandContext)!;
}

export function SignoffBrandingDrawer({ allowProfileLoad = false }: { allowProfileLoad?: boolean }) {
  const id = useId();
  const { branding, draft, valid, editBranding, restoreBranding } = useSignoffBranding();
  const [open, setOpen] = useState(false);
  const [fileStatus, setFileStatus] = useState('');
  const [fileError, setFileError] = useState('');
  const loadAttempt = useRef(0);
  useEffect(() => () => { loadAttempt.current += 1; }, []);

  function edit(changes: Partial<SignoffBrand>) {
    loadAttempt.current += 1;
    setFileStatus('');
    setFileError('');
    editBranding({ ...draft, ...changes });
  }

  async function load(file: File) {
    const attempt = ++loadAttempt.current;
    setFileStatus('');
    setFileError('');
    try {
      const profile = await readWorkspaceProfileFile(file);
      if (attempt !== loadAttempt.current) return;
      restoreBranding(profile.branding);
      setFileStatus(profile.branding ? 'Agency branding loaded from the workspace profile.' : 'The workspace profile has no agency branding.');
    } catch (error) {
      if (attempt === loadAttempt.current) setFileError(error instanceof Error ? error.message : 'The local workspace profile could not be read.');
    }
  }

  const accent = SIGNOFF_ACCENTS[branding?.accentKey ?? draft.accentKey];
  const showValidation = !valid && Boolean(branding || draft.agencyName || draft.preparedFor || draft.contactNote);

  return (
    <details className="signoff-branding" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Agency Sign-Off Branding{branding ? <span className="issue-badge badge-fixed" aria-hidden="true">Active</span> : null}</summary>
      {open ? (
        <div className="signoff-branding-body">
          <p className="field-help">Valid changes update your offline sign-off reports in this workspace.{allowProfileLoad
            ? ' Load a Workspace Profile saved in the Price Update Studio to reuse its branding.'
            : ' Save a Workspace Profile to reuse your branding.'}</p>
          <div className="signoff-branding-fields">
            <label>Agency name<input value={draft.agencyName} maxLength={120} aria-invalid={showValidation || undefined}
              aria-describedby={showValidation ? `${id}-validation` : undefined} onChange={(event) => edit({ agencyName: event.currentTarget.value })} /></label>
            <label>Prepared for<input value={draft.preparedFor} maxLength={120}
              onChange={(event) => edit({ preparedFor: event.currentTarget.value })} /></label>
            <label>Contact email or note<input value={draft.contactNote} maxLength={240}
              onChange={(event) => edit({ contactNote: event.currentTarget.value })} /></label>
          </div>
          <fieldset className="signoff-palettes">
            <legend>Accent palette</legend>
            <div>
              {ACCENTS.map((accentKey) => {
                const { label, background, foreground } = SIGNOFF_ACCENTS[accentKey];
                return (
                  <label key={accentKey}>
                    <input type="radio" name={`${id}-accent`} checked={draft.accentKey === accentKey} onChange={() => edit({ accentKey })} />
                    <span style={{ backgroundColor: background, color: foreground }}>{label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="signoff-preview" aria-label="Agency branding preview" style={{ backgroundColor: accent.background, color: accent.foreground }}>
            {branding ? (
              <>
                <strong>Prepared by {branding.agencyName}</strong>
                {branding.preparedFor ? <span>Prepared for {branding.preparedFor}</span> : null}
                {branding.contactNote ? <span>{branding.contactNote}</span> : null}
              </>
            ) : <span>Agency branding preview</span>}
          </div>
          {showValidation ? <p className="recipe-diagnostics" id={`${id}-validation`} role="status">
            Enter a valid agency name to activate these changes.
          </p> : null}
          <div className="signoff-branding-actions">
            {allowProfileLoad ? (
              <div className="file-picker">
                <input className="sr-only" id={`${id}-load`} type="file" accept=".json,application/json" onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void load(file);
                }} />
                <label className="button button-secondary button-small" htmlFor={`${id}-load`}>Load Workspace Profile (.json)</label>
              </div>
            ) : null}
            <button className="text-button" type="button" disabled={draft === EMPTY_BRAND} onClick={() => {
              loadAttempt.current += 1;
              setFileStatus('');
              setFileError('');
              restoreBranding();
            }}>Clear branding</button>
          </div>
          {fileStatus ? <p className="field-help" role="status">{fileStatus}</p> : null}
          {fileError ? <p className="recipe-diagnostics" role="alert">{fileError}</p> : null}
        </div>
      ) : null}
    </details>
  );
}
