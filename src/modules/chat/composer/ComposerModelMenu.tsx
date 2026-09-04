import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';

import type { ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];
const MODEL_SEARCH_MIN_OPTIONS = 12;
const MODEL_OPTIONS_PAGE_SIZE = 100;

type ComposerModelMenuProps = {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the section. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /** Model catalog for the active provider; empty hides the section. */
  modelOptions: ProviderModelOption[];
  /** Group selector prefixes when the active provider exposes a multi-provider catalog. */
  groupModelsByProvider: boolean;
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
};

/**
 * Rendered by chat's ChatComposer as the popover for choosing the active
 * provider's model and reasoning effort for the next turn.
 */
function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelOptions,
  groupModelsByProvider,
  onSelectModel,
  modelsLoading,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [isModelSectionOpen, setIsModelSectionOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [visibleModelCount, setVisibleModelCount] = useState(MODEL_OPTIONS_PAGE_SIZE);
  const modelSearchRef = useRef<HTMLInputElement | null>(null);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  useEffect(() => {
    if (!isOpen) {
      setIsModelSectionOpen(false);
      setModelQuery('');
      setVisibleModelCount(MODEL_OPTIONS_PAGE_SIZE);
    }
  }, [isOpen]);

  useEffect(() => {
    if (
      isModelSectionOpen
      && window.matchMedia('(pointer: fine)').matches
    ) {
      modelSearchRef.current?.focus();
    }
  }, [isModelSectionOpen]);

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const resolvedEffortOptions = useMemo<EffortOption[]>(
    () => (effortOptions.length > 0 ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] : []),
    [effortOptions],
  );
  const effortLabel = effort === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : effort;

  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.value === model) ?? null,
    [model, modelOptions],
  );
  const modelLabel = selectedModelOption?.label || model;
  const modelGroups = useMemo<[string, ProviderModelOption[]][]>(() => {
    const terms = modelQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const groups = new Map<string, ProviderModelOption[]>();

    for (const option of modelOptions) {
      if (terms.length > 0) {
        const searchableText = `${option.label} ${option.value}`.toLowerCase();
        if (!terms.every((term) => searchableText.includes(term))) {
          continue;
        }
      }

      const separator = groupModelsByProvider ? option.value.indexOf('/') : -1;
      const providerId = separator > 0 ? option.value.slice(0, separator) : '';
      const options = groups.get(providerId);
      if (options) {
        options.push(option);
      } else {
        groups.set(providerId, [option]);
      }
    }

    return [...groups];
  }, [groupModelsByProvider, modelOptions, modelQuery]);

  const filteredModelCount = useMemo(
    () => modelGroups.reduce((total, [, options]) => total + options.length, 0),
    [modelGroups],
  );
  const visibleModelGroups = useMemo<[string, ProviderModelOption[]][]>(() => {
    const groups: [string, ProviderModelOption[]][] = [];
    let remaining = visibleModelCount;

    for (const [providerId, options] of modelGroups) {
      if (remaining <= 0) {
        break;
      }
      const visibleOptions = options.slice(0, remaining);
      remaining -= visibleOptions.length;
      groups.push([providerId, visibleOptions]);
    }

    return groups;
  }, [modelGroups, visibleModelCount]);
  const firstMatch = modelGroups[0]?.[1][0] ?? null;

  const selectModel = useCallback((value: string) => {
    onSelectModel(value);
    setIsOpen(false);
  }, [onSelectModel]);

  const handleSearchKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || !firstMatch) {
      return;
    }
    event.preventDefault();
    selectModel(firstMatch.value);
  }, [firstMatch, selectModel]);

  const hasEffortSection = resolvedEffortOptions.length > 0;
  const hasModelSection = modelOptions.length > 0 || modelsLoading;
  if (!hasEffortSection && !hasModelSection) {
    return null;
  }

  const triggerLabel = hasModelSection ? modelLabel : effortLabel;
  const ariaLabel = t('composer.modelMenu', {
    defaultValue: 'Select model and reasoning effort',
  });
  const searchLabel = t('composer.searchModels', { defaultValue: 'Search models…' });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 max-w-20 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-56"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="truncate">{triggerLabel}</span>
        {hasModelSection && hasEffortSection && effort !== DEFAULT_EFFORT_VALUE && (
          <span className="hidden shrink-0 capitalize text-muted-foreground sm:inline">· {effortLabel}</span>
        )}
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {hasEffortSection && (
            <>
              <ComposerMenuHeading>
                {t('composer.reasoning', { defaultValue: 'Reasoning' })}
              </ComposerMenuHeading>
              {resolvedEffortOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  label={option.value === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : option.value}
                  description={option.description}
                  isSelected={option.value === effort}
                  onSelect={() => {
                    onSelectEffort(option.value);
                    setIsOpen(false);
                  }}
                  className="capitalize"
                />
              ))}
            </>
          )}

          {hasModelSection && (
            <>
              {hasEffortSection && <ComposerMenuSeparator />}
              <ComposerMenuItem
                role="menuitem"
                label={modelLabel}
                isSelected={false}
                onSelect={() => {
                  if (isModelSectionOpen) {
                    setModelQuery('');
                    setVisibleModelCount(MODEL_OPTIONS_PAGE_SIZE);
                  }
                  setIsModelSectionOpen(!isModelSectionOpen);
                }}
                trailing={
                  isModelSectionOpen
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                }
                className="text-muted-foreground"
              />

              {isModelSectionOpen && (
                <>
                  {modelOptions.length >= MODEL_SEARCH_MIN_OPTIONS && (
                    <div className="sticky top-0 z-10 -mx-1 mb-1 border-b border-border bg-popover px-2.5 pb-1.5 pt-1">
                      <div className="relative">
                        <Search
                          aria-hidden
                          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                        />
                        <input
                          ref={modelSearchRef}
                          type="search"
                          value={modelQuery}
                          onChange={(event) => {
                            setModelQuery(event.target.value);
                            setVisibleModelCount(MODEL_OPTIONS_PAGE_SIZE);
                          }}
                          onKeyDown={handleSearchKeyDown}
                          placeholder={searchLabel}
                          aria-label={searchLabel}
                          className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
                        />
                      </div>
                    </div>
                  )}
                  {modelOptions.length === 0 && modelsLoading && (
                    <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                      {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
                    </p>
                  )}
                  {visibleModelGroups.map(([providerId, options]) => (
                    <Fragment key={providerId || '__ungrouped__'}>
                      <ComposerMenuHeading>
                        {providerId || t('composer.model', { defaultValue: 'Model' })}
                      </ComposerMenuHeading>
                      {options.map((option) => (
                        <ComposerMenuItem
                          key={option.value}
                          label={option.label || option.value}
                          isSelected={option.value === model}
                          onSelect={() => selectModel(option.value)}
                        />
                      ))}
                    </Fragment>
                  ))}
                  {filteredModelCount === 0 && modelOptions.length > 0 && (
                    <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                      {t('composer.noModelMatches', {
                        defaultValue: 'No models match “{{query}}”',
                        query: modelQuery.trim(),
                      })}
                    </p>
                  )}
                  {visibleModelCount < filteredModelCount && (
                    <button
                      type="button"
                      onClick={() => setVisibleModelCount((count) => count + MODEL_OPTIONS_PAGE_SIZE)}
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
                    >
                      {t('composer.showMoreModels', { defaultValue: 'Show more models' })}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerModelMenu);
