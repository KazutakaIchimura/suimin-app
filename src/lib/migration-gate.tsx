// 起動時のマイグレーションの適用（設計書 3.3）。どの機能にも属さない起動時の基盤
import migrations from '@/drizzle/migrations';
import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';
import { useEffect, useState, type ReactNode } from 'react';
import { Text } from 'react-native';

import { getDb } from '@/lib/db';
import type { AppDb } from '@/lib/db.types';
import { logger } from '@/lib/logger';

type Props = { children: ReactNode };

/** DB を開いた結果。開けなかったら、そのエラー */
type Opened = { db: AppDb } | { error: unknown };

/**
 * `@/lib/db` の DB を開いてマイグレーションを適用し、終わるまで子要素を出さない。
 * DB を開けない・マイグレーションが失敗したら、失敗の表示を出して `app.migrate` の error ログを出す
 */
export function MigrationGate({ children }: Props) {
  // DB は最初の描画で1回だけ開く。開けなかったら開き直さず、起動し直すまで失敗の表示のままにする
  const [opened] = useState<Opened>(() => {
    try {
      return { db: getDb() };
    } catch (error) {
      return { error };
    }
  });

  if ('error' in opened) return <MigrationFailed error={opened.error} />;
  return <ApplyMigrations db={opened.db}>{children}</ApplyMigrations>;
}

function ApplyMigrations({ db, children }: Props & { db: AppDb }) {
  // useMigrations の型は expo-sqlite の DB だが、使うのは同期型の共通部分（dialect と session）だけ
  const { success, error } = useMigrations(db as Parameters<typeof useMigrations>[0], migrations);

  if (error) return <MigrationFailed error={error} />;
  if (!success) return null;
  return <>{children}</>;
}

/** 失敗の表示。ログはエラーが変わったときに1回だけ出す */
function MigrationFailed({ error }: { error: unknown }) {
  useEffect(() => {
    logger.error('app.migrate', { err: error });
  }, [error]);

  return <Text>データベースの準備に失敗しました</Text>;
}
