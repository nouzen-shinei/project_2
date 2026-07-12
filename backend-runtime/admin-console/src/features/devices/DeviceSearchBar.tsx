import { Search, X } from 'lucide-react';

/** Upper bound on the device search term (Requirement 4.1: 1–256 characters). */
export const DEVICE_SEARCH_MAX_LENGTH = 256;

interface DeviceSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  disabled?: boolean;
}

/**
 * Search input for the Device Console. The term is matched (server-side) against
 * device name, type, browser, OS, model, IP, owner email, and owner display name
 * after trimming and case-folding (Requirement 4.1). An empty term shows all
 * devices for the tenant subject to the active filter (Requirement 4.3); the
 * `maxLength` guard enforces the 256-character upper bound.
 */
export function DeviceSearchBar({ value, onChange, onClear, disabled }: DeviceSearchBarProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <span>Search devices</span>
      <div className="tenant-search-input">
        <Search size={16} />
        <input
          type="text"
          value={value}
          maxLength={DEVICE_SEARCH_MAX_LENGTH}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Name, type, browser, OS, model, IP, owner email or name"
          disabled={disabled}
          aria-label="Search devices"
        />
        {value ? (
          <button
            type="button"
            className="text-button small-link"
            onClick={onClear}
            disabled={disabled}
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
    </label>
  );
}
