import fs from "fs";
import path from "path";

interface SystemSettings {
  platform_tests_enabled: boolean;
}

const SETTINGS_FILE = path.join(process.cwd(), "data", "settings.json");

const defaultSettings: SystemSettings = {
  platform_tests_enabled: true,
};

export function getSystemSettings(): SystemSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, "utf-8");
      return { ...defaultSettings, ...JSON.parse(data) };
    }
  } catch (error) {
    console.error("Error reading system settings:", error);
  }
  return defaultSettings;
}

export function updateSystemSettings(newSettings: Partial<SystemSettings>): SystemSettings {
  try {
    const current = getSystemSettings();
    const updated = { ...current, ...newSettings };
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), "utf-8");
    return updated;
  } catch (error) {
    console.error("Error saving system settings:", error);
    return getSystemSettings();
  }
}
