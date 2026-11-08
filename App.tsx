import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { createApplication } from "./src/bootstrap/create-application";

type Application = Awaited<ReturnType<typeof createApplication>>;

type StartupState =
  | { status: "loading" }
  | { status: "ready"; application: Application }
  | { status: "error"; message: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected startup error occurred.";
}

export default function App() {
  const [startupState, setStartupState] = useState<StartupState>({ status: "loading" });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let isActive = true;

    async function prepareApplication() {
      setStartupState({ status: "loading" });
      try {
        const application = await createApplication({
          openDatabase: () => SQLite.openDatabaseAsync("labsisd.db"),
          createId: () => Crypto.randomUUID(),
        });
        if (isActive) {
          setStartupState({ status: "ready", application });
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
