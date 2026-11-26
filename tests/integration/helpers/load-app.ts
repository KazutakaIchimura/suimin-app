// 画面の中間テスト（手順14・15）で、アプリを読み込み直して `renderRouter` で描画する補助（設計書「テストリスト」手順14 の前提）。
// 使う側のテストファイルは、最上位で次をそろえる：
//   process.env.RNTL_SKIP_AUTO_CLEANUP = 'true';（自動の後片付けを止める。各テストで読み込み直すため）
//   ネイティブライブラリ・`@/lib/db` の jest.mock（巻き上げの都合でテストファイルに書く）
//   afterEach で `await cleanupApp()`
import type * as HealthKit from '@kingstinct/react-native-healthkit';
import type { AppStateStatus } from 'react-native';
import type * as HealthConnect from 'react-native-health-connect';

import type { HealthOs } from '@/features/sleep-record/sleep-record.types';

import { flushPromises } from './deferred';

type Rntl = typeof import('expo-router/testing-library');

let cleanup: (() => Promise<void>) | undefined;

/**
 * テストの前に、expo-router と実際の画面ルートを一度読み込んで変換を済ませる（`beforeAll` で呼ぶ）。
 * 変換のキャッシュが空のとき（設定を変えた直後など）に、最初のテストがその時間で上限を超えないようにする
 */
export function warmUpApp(): void {
  jest.isolateModules(() => {
    require('expo-router/testing-library');
    require('@/app/_layout');
    require('@/app/index');
    require('@/app/sleep/[date]');
  });
}

/** 描画したものを片づける（afterEach で呼ぶ） */
export async function cleanupApp(): Promise<void> {
  await cleanup?.();
  cleanup = undefined;
}

/**
 * アプリを読み込み直す（store の状態・実行中の Promise を前のテストから持ち越さない）。
 * 戻り値の `open` で実際の `src/app/` を描画し、`emit` で `AppState` の変化を流し込む
 */
export function loadApp(os: HealthOs = 'ios') {
  jest.resetModules();
  const { Platform, AppState } = require('react-native') as typeof import('react-native');
  jest.replaceProperty(Platform, 'OS', os);
  const listeners: ((state: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    listeners.push(listener as (state: AppStateStatus) => void);
    return { remove: jest.fn() };
  });
  (require('./reset-health-mocks') as typeof import('./reset-health-mocks')).resetHealthMocks();
  const rntl = require('expo-router/testing-library') as Rntl;
  cleanup = rntl.cleanup;
  // 各テストで expo-router ごと読み込み直すため、並列実行で重いと初回の描画が遅くなる。条件を待つ上限だけを上げる
  rntl.configure({ asyncUtilTimeout: 5000 });
  const hk = jest.mocked(require('@kingstinct/react-native-healthkit') as typeof HealthKit);
  const hc = jest.mocked(require('react-native-health-connect') as typeof HealthConnect);
  const store = (
    require('@/features/sleep-record/sleep-record.store') as typeof import('@/features/sleep-record/sleep-record.store')
  ).useSleepRecordStore;
  const open = (initialUrl = '/') => rntl.renderRouter('src/app', { initialUrl });
  const emit = async (state: AppStateStatus) => {
    await rntl.act(async () => {
      for (const listener of listeners) listener(state);
      await flushPromises();
    });
  };
  return {
    rntl,
    /** 描画のたびに入れ替わるので、使う時点で読む */
    get screen() {
      return rntl.screen;
    },
    hk,
    hc,
    store,
    open,
    emit,
  };
}

export type LoadedApp = ReturnType<typeof loadApp>;
