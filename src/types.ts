import type { AccessGrantRow, ApiKeyRow, UserRow } from "./db";
import type { EnvBindings } from "./db";

export type AuthContext =
  | {
      type: "user";
      apiKey: ApiKeyRow;
      scopes: ["*"];
    }
  | {
      type: "developer";
      accessGrant: AccessGrantRow;
      scopes: string[];
    };

export type AppEnv = {
  Bindings: EnvBindings;
  Variables: {
    auth: AuthContext;
    user: UserRow;
  };
};
