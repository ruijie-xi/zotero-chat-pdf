declare namespace _ZoteroTypes {
  interface Prefs {
    PluginPrefsMap: {
      mineruToken: string;
      llmApiBase: string;
      llmApiKey: string;
      llmModel: string;
      cacheDir: string;
      maxContextChars: number;
    };
  }
}
