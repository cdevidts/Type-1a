/**
 * Lo que la pantalla de Ajustes muestra después de exportar o importar.
 *
 * Vive aparte de `backupIO.ts` para que `SettingsModal` no tenga que importar
 * `expo-file-system` ni `expo-sqlite` solo para tipar un mensaje.
 */

export interface BackupExportOutcome {
  /** Qué decirle a la usuaria. Ya redactado: la pantalla no arma frases. */
  message: string;
  records: number;
  photos: number;
}

export interface BackupImportOutcome {
  message: string;
  /** `false` si el archivo se rechazó: nada se escribió. */
  applied: boolean;
}
