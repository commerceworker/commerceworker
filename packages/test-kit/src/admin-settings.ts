import type { AdminSetting, AdminSettings } from '@commerceworker/ports';

export class InMemoryAdminSettings implements AdminSettings {
  private readonly rows = new Map<string, AdminSetting>();
  async record(key: string) {
    const row = this.rows.get(key);
    return row ? { ...row } : undefined;
  }
  async remove(key: string) {
    this.rows.delete(key);
  }
  async get(key: string) {
    return this.rows.get(key)?.value;
  }
  async set(setting: AdminSetting) {
    this.rows.set(setting.key, { ...setting });
  }
  async claim(setting: AdminSetting) {
    if (this.rows.get(setting.key)?.value === setting.value) return false;
    this.rows.set(setting.key, { ...setting });
    return true;
  }
  async release(key: string, claimed: string, previous: string | undefined) {
    const row = this.rows.get(key);
    if (!row || row.value !== claimed) return;
    if (previous === undefined) this.rows.delete(key);
    else this.rows.set(key, { ...row, value: previous });
  }
}
