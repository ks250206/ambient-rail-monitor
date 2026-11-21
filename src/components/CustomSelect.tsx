import { Check, ChevronDown } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n.ts';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
  description?: string;
}

export interface SelectOptionGroup<T extends string = string> {
  label: string;
  options: SelectOption<T>[];
}

export interface CustomSelectProps<T extends string = string> {
  id?: string;
  value: T;
  onChange: (value: T) => void;
  options?: SelectOption<T>[];
  groups?: SelectOptionGroup<T>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  size?: 'sm' | 'md';
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: 'bottom' | 'top';
}

export function CustomSelect<T extends string = string>({
  id,
  value,
  onChange,
  options,
  groups,
  placeholder,
  disabled = false,
  className = '',
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  size = 'md',
}: CustomSelectProps<T>) {
  const { pick } = useI18n();
  const generatedId = useId();
  const triggerId = id ?? `rf-select-${generatedId}`;
  const listboxId = `${triggerId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef({ query: '', timer: 0 });
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number>(-1);
  const [position, setPosition] = useState<MenuPosition>({
    top: 0,
    left: 0,
    width: 200,
    maxHeight: 280,
    placement: 'bottom',
  });

  const sections = useMemo<SelectOptionGroup<T>[]>(() => {
    if (groups && groups.length > 0) return groups;
    return [{ label: '', options: options ?? [] }];
  }, [groups, options]);

  const flatOptions = useMemo(() => sections.flatMap((section) => section.options), [sections]);

  const selectedOption = flatOptions.find((option) => option.value === value);
  const displayLabel = selectedOption?.label ?? placeholder ?? '';

  const firstEnabledIndex = () => flatOptions.findIndex((option) => !option.disabled);
  const lastEnabledIndex = () => {
    for (let i = flatOptions.length - 1; i >= 0; i--) {
      if (!flatOptions[i].disabled) return i;
    }
    return -1;
  };
  const nextEnabledIndex = (from: number, step: 1 | -1) => {
    if (flatOptions.length === 0) return -1;
    let index = from;
    for (let tried = 0; tried < flatOptions.length; tried++) {
      index = (index + step + flatOptions.length) % flatOptions.length;
      if (!flatOptions[index].disabled) return index;
    }
    return -1;
  };

  function openMenu(initialIndex?: number) {
    if (disabled) return;
    const selectedIndex = flatOptions.findIndex(
      (option) => option.value === value && !option.disabled,
    );
    const start =
      initialIndex !== undefined && initialIndex >= 0
        ? initialIndex
        : selectedIndex >= 0
          ? selectedIndex
          : firstEnabledIndex();
    setHighlighted(start);
    setOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function commitIndex(index: number) {
    const option = flatOptions[index];
    if (!option || option.disabled) return;
    closeMenu(true);
    if (option.value !== value) onChange(option.value);
  }

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportHeight = window.innerHeight || 800;
      const viewportWidth = window.innerWidth || 1280;
      const spaceBelow = viewportHeight - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      const placement: 'bottom' | 'top' =
        spaceBelow < 180 && spaceAbove > spaceBelow ? 'top' : 'bottom';
      const maxHeight = Math.max(
        120,
        Math.min(320, placement === 'bottom' ? spaceBelow : spaceAbove),
      );
      const width = Math.min(Math.max(rect.width, 160), viewportWidth - 16);
      const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
      const top = placement === 'bottom' ? rect.bottom + 4 : rect.top - 4;
      setPosition({ top, left, width, maxHeight, placement });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || triggerRef.current?.contains(target) || menuRef.current?.contains(target))
        return;
      closeMenu(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || highlighted < 0 || !menuRef.current) return;
    const activeEl = menuRef.current.querySelector<HTMLElement>(
      `[data-option-index="${highlighted}"]`,
    );
    activeEl?.scrollIntoView?.({ block: 'nearest' });
  }, [open, highlighted]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) openMenu();
      else setHighlighted((prev) => nextEnabledIndex(prev < 0 ? -1 : prev, 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu(lastEnabledIndex());
      else setHighlighted((prev) => nextEnabledIndex(prev < 0 ? 0 : prev, -1));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      if (!open) openMenu(firstEnabledIndex());
      else setHighlighted(firstEnabledIndex());
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      if (!open) openMenu(lastEnabledIndex());
      else setHighlighted(lastEnabledIndex());
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) openMenu();
      else if (highlighted >= 0) commitIndex(highlighted);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab' && open) {
      closeMenu(false);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      window.clearTimeout(typeaheadRef.current.timer);
      const nextQuery = (typeaheadRef.current.query + event.key).toLowerCase();
      typeaheadRef.current.query = nextQuery;
      typeaheadRef.current.timer = window.setTimeout(() => {
        typeaheadRef.current.query = '';
      }, 500);
      const match = flatOptions.findIndex(
        (option) => !option.disabled && option.label.toLowerCase().startsWith(nextQuery),
      );
      if (match >= 0) {
        if (!open) openMenu(match);
        else setHighlighted(match);
      }
    }
  }

  let runningIndex = 0;

  return (
    <div className={`rf-select ${size === 'sm' ? 'rf-select-sm' : ''} ${className}`}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && highlighted >= 0 ? `${listboxId}-opt-${highlighted}` : undefined
        }
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        disabled={disabled}
        data-value={value}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={handleKeyDown}
        className="rf-select-trigger"
      >
        <span className={`rf-select-value ${!selectedOption ? 'is-placeholder' : ''}`}>
          {displayLabel}
        </span>
        <ChevronDown
          size={size === 'sm' ? 14 : 16}
          aria-hidden="true"
          className={`rf-select-chevron ${open ? 'is-open' : ''}`}
        />
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className={`rf-select-menu ${position.placement === 'top' ? 'is-top' : ''}`}
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
              transform: position.placement === 'top' ? 'translateY(-100%)' : undefined,
            }}
          >
            {flatOptions.length === 0 ? (
              <div className="rf-select-empty">
                {pick('選択肢がありません', 'No options available')}
              </div>
            ) : (
              sections.map((section, sectionIdx) => {
                if (section.options.length === 0) return null;
                return (
                  <div
                    key={section.label || `section-${sectionIdx}`}
                    role={section.label ? 'group' : undefined}
                    aria-label={section.label || undefined}
                    className="rf-select-group"
                  >
                    {section.label && <div className="rf-select-group-label">{section.label}</div>}
                    {section.options.map((option) => {
                      const optionIndex = runningIndex++;
                      const isSelected = option.value === value;
                      const isHighlighted = optionIndex === highlighted;
                      return (
                        <button
                          key={`${sectionIdx}-${option.value}`}
                          id={`${listboxId}-opt-${optionIndex}`}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          aria-disabled={option.disabled || undefined}
                          disabled={option.disabled}
                          data-option-index={optionIndex}
                          data-option-value={option.value}
                          onMouseEnter={() => {
                            if (!option.disabled) setHighlighted(optionIndex);
                          }}
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => commitIndex(optionIndex)}
                          className={`rf-select-option ${isSelected ? 'is-selected' : ''} ${isHighlighted ? 'is-highlighted' : ''}`}
                        >
                          <span className="rf-select-option-body">
                            <span className="rf-select-option-label">{option.label}</span>
                            {option.description && (
                              <span className="rf-select-option-desc">{option.description}</span>
                            )}
                          </span>
                          {isSelected && (
                            <Check size={14} aria-hidden="true" className="rf-select-check" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
