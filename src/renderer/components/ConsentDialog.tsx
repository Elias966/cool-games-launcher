import { ADULT_ACCEPT_LABEL, ADULT_WARNING_TEXT, ADULT_WARNING_TITLE } from '@shared/policy';
import { Dialog } from './ui';
import { t } from '../i18n';

/** The adult-content warning. Cancel is focused by default and never enables anything. */
export function ConsentDialog({ open, onCancel, onAccept }: { open: boolean; onCancel: () => void; onAccept: () => void }) {
  return (
    <Dialog
      open={open}
      title={ADULT_WARNING_TITLE}
      onClose={onCancel}
      tone="warning"
      initialFocus="[data-autofocus]"
      actions={
        <>
          <button className="btn btn--secondary btn--md" onClick={onCancel} data-autofocus>
            <span>{t('Cancel')}</span>
          </button>
          <button className="btn btn--danger btn--md" onClick={onAccept}>
            <span>{ADULT_ACCEPT_LABEL}</span>
          </button>
        </>
      }
    >
      <p>{ADULT_WARNING_TEXT}</p>
    </Dialog>
  );
}
