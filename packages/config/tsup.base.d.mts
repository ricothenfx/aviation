export interface TsupBaseOptions {
  entry?: string[];
}

export declare function tsupBase(options?: TsupBaseOptions): {
  entry: string[];
  format: ("esm" | "cjs")[];
  dts: boolean;
  sourcemap: boolean;
  clean: boolean;
};
