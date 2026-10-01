import {
  createRootRoute,
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { getVersion } from "@tauri-apps/api/app";
import { Cpu, Laptop, Moon, Settings, Sun, User } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import logo from "@/assets/logo.png";
import { cmd } from "@/commands";
import { useAppearance } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { appearancePreference } from "@/lib/appearance";

function App() {
  const [username, setUsername] = useState("");
  const [version, setVersion] = useState("");
  const {
    appearance,
    resolvedTheme,
    systemTheme,
    ready,
    saving,
    setAppearance,
  } = useAppearance();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  useEffect(() => {
    const loadUsername = async () => {
      try {
        setUsername(await cmd.system.getCurrentUsername());
      } catch (err) {
        console.error("Failed to get username:", err);
      }
    };

    const loadVersion = async () => {
      try {
        setVersion(await getVersion());
      } catch (err) {
        console.error("Failed to get app version:", err);
      }
    };

    loadUsername();
    loadVersion();
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-50 backdrop-blur-lg bg-background/80 border-b border-border">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3 sm:gap-8">
              <div className="flex items-center gap-3">
                <img src={logo} className="h-8" alt="Biopass logo" />
                <span className="font-bold text-lg hidden sm:inline-block">
                  Biopass
                </span>
                {version && (
                  <span className="text-xs text-muted-foreground">
                    v{version}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Link
                  to="/configuration"
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors cursor-pointer ${
                    pathname === "/configuration"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Settings className="w-4 h-4" />
                  <span className="text-sm font-medium">Sign-in settings</span>
                </Link>
                <Link
                  to="/models"
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors cursor-pointer ${
                    pathname === "/models"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Cpu className="w-4 h-4" />
                  <span className="text-sm font-medium">AI models</span>
                </Link>
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-4">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!ready || saving}
                    aria-label={`Appearance: ${appearance}`}
                    className="gap-2"
                  >
                    {appearance === "system" ? (
                      <Laptop className="h-4 w-4" />
                    ) : resolvedTheme === "dark" ? (
                      <Moon className="h-4 w-4" />
                    ) : (
                      <Sun className="h-4 w-4" />
                    )}
                    <span className="hidden sm:inline">
                      {appearance === "system"
                        ? "System"
                        : appearance === "dark"
                          ? "Dark"
                          : "Light"}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Appearance</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={appearance}
                    onValueChange={(value) => {
                      void setAppearance(appearancePreference(value)).catch(
                        (error) =>
                          toast.error(`Could not save appearance: ${error}`),
                      );
                    }}
                  >
                    <DropdownMenuRadioItem value="system">
                      <Laptop className="mr-2 h-4 w-4" />
                      <span>
                        Follow system{" "}
                        <span className="text-muted-foreground">
                          (currently {systemTheme})
                        </span>
                      </span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="light">
                      <Sun className="mr-2 h-4 w-4" />
                      Light
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">
                      <Moon className="mr-2 h-4 w-4" />
                      Dark
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {username && (
                <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted/50 border border-border/50">
                  <User className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{username}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto">
        <Outlet />
      </main>
    </div>
  );
}

function RootLayout() {
  return (
    <>
      <App />
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </>
  );
}

export const Route = createRootRoute({ component: RootLayout });
