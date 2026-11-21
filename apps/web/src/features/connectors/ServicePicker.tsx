import { CONNECTOR_SERVICES, type ConnectorService, serviceLabel } from '@whombat/core/domain';
import styles from './Connectors.module.css';

export interface ServicePickerProps {
  value: readonly ConnectorService[];
  onChange: (next: ConnectorService[]) => void;
  disabled?: boolean;
  /**
   * Services already connected: shown ticked and fixed, because connecting again only adds services (CN-04);
   * Disconnect removes them all (IN-31).
   */
  locked?: readonly ConnectorService[];
  /** Accessible name of the group. */
  label?: string;
}

/** The services to connect, as real checkboxes (all ticked by default, CN-04), in service order. */
export function ServicePicker({
  value,
  onChange,
  disabled = false,
  locked = [],
  label = 'Services to connect',
}: ServicePickerProps) {
  return (
    <fieldset className={styles.services} disabled={disabled}>
      <legend className={styles.srOnly}>{label}</legend>
      {CONNECTOR_SERVICES.map((service) => {
        const fixed = locked.includes(service);
        const checked = fixed || value.includes(service);
        return (
          <label key={service} className={styles.service}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={checked}
              disabled={fixed}
              onChange={() =>
                onChange(CONNECTOR_SERVICES.filter((s) => (s === service ? !checked : value.includes(s))))
              }
            />
            {serviceLabel(service, 'google')}
          </label>
        );
      })}
    </fieldset>
  );
}
