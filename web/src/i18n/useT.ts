import { useSyncExternalStore } from 'react';
import {
  getLocale,
  subscribeLocale,
  translate,
  translateCount,
  type Locale,
  type MessageKey,
  type TranslateParams,
} from './index';

export interface Translator {
  /** Translate a key. */
  t: (key: MessageKey, params?: TranslateParams) => string;
  /** Translate a plural-aware key; `count` also fills `{count}`. */
  tc: (key: MessageKey, count: number, params?: TranslateParams) => string;
  locale: Locale;
}

/**
 * Subscribes the calling component to the active locale, so switching the
 * language re-renders exactly the components that display text.
 */
export function useT(): Translator {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return { t: translate, tc: translateCount, locale };
}
