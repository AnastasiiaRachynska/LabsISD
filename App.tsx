import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { createApplication } from "./src/bootstrap/create-application";
import { createApiSession } from "./src/wnt12/api-session";
import { createSyncApi } from "./src/wnt12/sync-api";

type Application = Awaited<ReturnType<typeof createApplication>>;
type ApiSession = ReturnType<typeof createApiSession>;

type StartupState =
  | { status: "loading" }
  | { status: "ready"; application: Application }
  | { status: "error"; message: string };

type AuthMode = "login" | "register";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected startup error occurred.";
}

export default function App() {
  const [startupState, setStartupState] = useState<StartupState>({ status: "loading" });
  const [retryCount, setRetryCount] = useState(0);
  const [apiSession, setApiSession] = useState<ApiSession | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [conflictCount, setConflictCount] = useState(0);
  const [accountMessage, setAccountMessage] = useState("");
  const [accountError, setAccountError] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncError, setSyncError] = useState(false);

  useEffect(() => {
    let isActive = true;

    async function prepareApplication() {
      setStartupState({ status: "loading" });
      try {
        const session = createApiSession({ secureStore: SecureStore });
        const syncApi = createSyncApi({
          getBaseUrl: () => session.getBaseUrl(),
          getAccessToken: () => session.getAccessToken(),
        });
        const application = await createApplication({
          openDatabase: () => SQLite.openDatabaseAsync("labsisd.db"),
          createId: () => Crypto.randomUUID(),
          syncApi,
        });
        let restored: Awaited<ReturnType<ApiSession["restore"]>> = {
          baseUrl: "",
          user: null,
        };
        try {
          restored = await session.restore();
        } catch (error) {
          if (isActive) {
            setAccountError(true);
            setAccountMessage(`Could not restore API account settings: ${getErrorMessage(error)}`);
          }
        }
        if (isActive) {
          setApiSession(session);
          setApiBaseUrl(restored.baseUrl);
          setUserEmail(restored.user?.email || null);
          setStartupState({ status: "ready", application });
          try {
            const conflicts = await application.repositories.conflicts.list();
            setConflictCount(conflicts.length);
          } catch (error) {
            setSyncError(true);
            setSyncMessage(`Could not load saved conflict status: ${getErrorMessage(error)}`);
          }
        }
      } catch (error) {
        if (isActive) {
          setStartupState({ status: "error", message: getErrorMessage(error) });
        }
      }
    }

    void prepareApplication();
    return () => {
      isActive = false;
    };
  }, [retryCount]);

  async function saveApiBaseUrl(): Promise<void> {
    if (!apiSession) {
      setAccountError(true);
      setAccountMessage("API account services are not ready.");
      return;
    }
    try {
      const normalized = await apiSession.setBaseUrl(apiBaseUrl);
      setApiBaseUrl(normalized);
      setAccountError(false);
      setAccountMessage("API server address saved securely.");
    } catch (error) {
      setAccountError(true);
      setAccountMessage(getErrorMessage(error));
    }
  }

  async function authenticate(): Promise<void> {
    if (!apiSession) {
      setAccountError(true);
      setAccountMessage("API account services are not ready.");
      return;
    }
    setAuthBusy(true);
    setAccountMessage("");
    try {
      await apiSession.setBaseUrl(apiBaseUrl);
      const user = authMode === "register"
        ? await apiSession.register(email, password)
        : await apiSession.login(email, password);
      setApiBaseUrl(apiSession.getBaseUrl());
      setUserEmail(user.email);
      setPassword("");
      setAccountError(false);
      setAccountMessage(`Signed in as ${user.email}.`);
    } catch (error) {
      setAccountError(true);
      setAccountMessage(getErrorMessage(error));
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut(): Promise<void> {
    if (!apiSession) {
      return;
    }
    try {
      await apiSession.logout();
      setUserEmail(null);
      setPassword("");
      setAccountError(false);
      setAccountMessage("Signed out. Your local data remains available offline.");
    } catch (error) {
      setAccountError(true);
      setAccountMessage(getErrorMessage(error));
    }
  }

  async function synchronize(): Promise<void> {
    if (startupState.status !== "ready" || !startupState.application.synchronization) {
      setSyncError(true);
      setSyncMessage("Synchronization is not ready.");
      return;
    }
    setSyncBusy(true);
    setSyncMessage("");
    try {
      const pushed = await startupState.application.synchronization.pushPendingChanges();
      const pulled = await startupState.application.synchronization.pullChanges();
      const conflicts = await startupState.application.repositories.conflicts.list();
      setConflictCount(conflicts.length);
      setSyncError(false);
      setSyncMessage(
        `Sync complete: ${pushed.acknowledged} uploaded, ${pulled.applied} downloaded. ` +
          `${conflicts.length} unresolved conflict${conflicts.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setSyncError(true);
      setSyncMessage(`Sync failed: ${getErrorMessage(error)}`);
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>OFFLINE-FIRST IDEA ORGANIZER</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Your ideas, ready when you are.
        </Text>
        <Text style={styles.description}>
          Capture and organize your creative ideas, even without an internet connection.
        </Text>

        <View accessibilityLiveRegion="polite" style={styles.statusCard}>
          {startupState.status === "loading" ? (
            <>
              <ActivityIndicator color="#315c4b" />
              <Text style={styles.statusText}>Preparing local storage…</Text>
            </>
          ) : startupState.status === "ready" ? (
            <Text style={styles.statusText}>Local storage is ready.</Text>
          ) : (
            <>
              <Text accessibilityRole="alert" style={styles.errorText}>
                Could not prepare local storage: {startupState.message}
              </Text>
              <Pressable
                accessibilityLabel="Retry local storage initialization"
                accessibilityRole="button"
                onPress={() => setRetryCount((count) => count + 1)}
                style={styles.retryButton}
              >
                <Text style={styles.retryButtonText}>Try again</Text>
              </Pressable>
            </>
          )}
        </View>
        {startupState.status === "ready" && (
          <View style={styles.accountCard}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>API account and sync</Text>
            <Text style={styles.fieldLabel}>API server URL</Text>
            <TextInput
              accessibilityLabel="API server URL"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={setApiBaseUrl}
              placeholder="http://192.168.1.10:3000"
              style={styles.input}
              value={apiBaseUrl}
            />
            <Pressable
              accessibilityRole="button"
              disabled={authBusy || syncBusy}
              onPress={() => void saveApiBaseUrl()}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Save server URL</Text>
            </Pressable>
            {userEmail ? (
              <>
                <Text style={styles.statusText}>Signed in as {userEmail}</Text>
                <Text style={styles.statusText}>
                  {conflictCount === 0
                    ? "No unresolved synchronization conflicts."
                    : `${conflictCount} unresolved synchronization conflict${conflictCount === 1 ? "" : "s"}.`}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={syncBusy || authBusy}
                  onPress={() => void synchronize()}
                  style={styles.primaryButton}
                >
                  {syncBusy
                    ? <ActivityIndicator color="#ffffff" />
                    : <Text style={styles.primaryButtonText}>Sync now</Text>}
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={authBusy || syncBusy}
                  onPress={() => void signOut()}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>Sign out</Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.modeButtons}>
                  {(["login", "register"] as const).map((mode) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: authMode === mode }}
                      key={mode}
                      onPress={() => setAuthMode(mode)}
                      style={[styles.modeButton, authMode === mode && styles.modeButtonSelected]}
                    >
                      <Text style={authMode === mode ? styles.modeButtonTextSelected : styles.modeButtonText}>
                        {mode === "login" ? "Sign in" : "Create account"}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.fieldLabel}>Email</Text>
                <TextInput
                  accessibilityLabel="Email"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  keyboardType="email-address"
                  onChangeText={setEmail}
                  style={styles.input}
                  value={email}
                />
                <Text style={styles.fieldLabel}>Password</Text>
                <TextInput
                  accessibilityLabel="Password"
                  autoCapitalize="none"
                  autoComplete={authMode === "register" ? "new-password" : "current-password"}
                  onChangeText={setPassword}
                  secureTextEntry
                  style={styles.input}
                  value={password}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={authBusy || syncBusy}
                  onPress={() => void authenticate()}
                  style={styles.primaryButton}
                >
                  {authBusy
                    ? <ActivityIndicator color="#ffffff" />
                    : <Text style={styles.primaryButtonText}>
                        {authMode === "register" ? "Create account" : "Sign in"}
                      </Text>}
                </Pressable>
              </>
            )}
            {accountMessage ? (
              <Text accessibilityRole={accountError ? "alert" : undefined} style={accountError ? styles.errorText : styles.statusText}>
                {accountMessage}
              </Text>
            ) : null}
            {syncMessage ? (
              <Text accessibilityRole={syncError ? "alert" : undefined} style={syncError ? styles.errorText : styles.statusText}>
                {syncMessage}
              </Text>
            ) : null}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f5f3ed",
  },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 28,
    paddingVertical: 36,
    gap: 16,
  },
  eyebrow: {
    color: "#315c4b",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  title: {
    color: "#17251f",
    fontSize: 34,
    fontWeight: "700",
    lineHeight: 42,
  },
  description: {
    color: "#4b5a53",
    fontSize: 17,
    lineHeight: 25,
  },
  statusCard: {
    alignItems: "flex-start",
    backgroundColor: "#ffffff",
    borderRadius: 16,
    gap: 12,
    marginTop: 16,
    padding: 18,
  },
  accountCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    gap: 12,
    marginTop: 4,
    padding: 18,
  },
  sectionTitle: {
    color: "#17251f",
    fontSize: 20,
    fontWeight: "700",
  },
  fieldLabel: {
    color: "#4b5a53",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: -8,
  },
  input: {
    borderColor: "#cbd5cf",
    borderRadius: 10,
    borderWidth: 1,
    color: "#17251f",
    minHeight: 46,
    paddingHorizontal: 12,
  },
  modeButtons: {
    flexDirection: "row",
    gap: 8,
  },
  modeButton: {
    alignItems: "center",
    borderColor: "#cbd5cf",
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 42,
  },
  modeButtonSelected: {
    backgroundColor: "#e5eee9",
    borderColor: "#315c4b",
  },
  modeButtonText: {
    color: "#4b5a53",
    fontWeight: "600",
  },
  modeButtonTextSelected: {
    color: "#315c4b",
    fontWeight: "700",
  },
  primaryButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#315c4b",
    borderRadius: 10,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 18,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: "#315c4b",
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    color: "#315c4b",
    fontWeight: "600",
  },
  statusText: {
    color: "#315c4b",
    fontSize: 16,
  },
  errorText: {
    color: "#9b2c2c",
    fontSize: 16,
    lineHeight: 23,
  },
  retryButton: {
    alignSelf: "flex-start",
    backgroundColor: "#315c4b",
    borderRadius: 10,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  retryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
});
