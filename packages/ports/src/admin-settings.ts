/** Deployment-wide human-auth settings, separate from content space settings. */
export interface AdminSetting {
  key: string;
  value: string;
  updatedAt: number;
  updatedBy: string;
}

export interface AdminSettings {
  record(key: string): Promise<AdminSetting | undefined>;
  remove(key: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  set(setting: AdminSetting): Promise<void>;
  /** Claim a setup-code hash once. Only a different value can replace the previous claim. */
  claim(setting: AdminSetting): Promise<boolean>;
  /** Return a failed claim only while this value still owns it; never undo a newer claim. */
  release(key: string, claimed: string, previous: string | undefined): Promise<void>;
}
