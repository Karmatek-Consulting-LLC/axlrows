import {
  Activity,
  CircleCheck,
  CircleX,
  DatabaseZap,
  Info,
  KeyRound,
  Pencil,
  Plus,
  Server,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/Button";
import { Dialog, DialogClose, DialogContent } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { Field } from "../components/ui/Field";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Switch } from "../components/ui/Switch";
import { Tip } from "../components/ui/Tooltip";
import { ipc } from "../lib/ipc";
import {
  AXL_VERSIONS,
  DEFAULT_AXL_VERSION,
  type AxlVersion,
  type TestUcmResult,
  type Ucm,
  type UcmInput,
} from "../lib/types";
import { cn, errMsg, fmtMs, ucmHue } from "../lib/utils";
import { useSchemaStore } from "../stores/schema";
import { useUcmsStore } from "../stores/ucms";

export function ServersView() {
  const ucms = useUcmsStore((s) => s.ucms);
  const loaded = useUcmsStore((s) => s.loaded);
  const [editing, setEditing] = useState<Ucm | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  function openAdd() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(u: Ucm) {
    setEditing(u);
    setDialogOpen(true);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-4 py-3">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight">UCM servers</h1>
          <p className="mt-0.5 text-xs text-mut">Publishers you query over AXL.</p>
        </div>
        <Button variant="primary" onClick={openAdd}>
          <Plus className="size-3.5" />
          Add server
        </Button>
      </header>

      <div className="min-h-0 grow overflow-y-auto p-4">
        {!loaded ? (
          <div className="flex h-32 items-center justify-center text-mut">
            <Spinner className="text-accent" />
          </div>
        ) : ucms.length === 0 ? (
          <EmptyState icon={Server} title="No UCM servers yet">
            Add your first Unified CM publisher to start running AXL SQL queries against it.
          </EmptyState>
        ) : (
          <ul className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
            {ucms.map((u) => (
              <ServerCard key={u.id} ucm={u} onEdit={() => openEdit(u)} />
            ))}
          </ul>
        )}
      </div>

      <UcmDialog
        key={`${editing?.id ?? "new"}:${dialogOpen ? "open" : "closed"}`}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />
    </div>
  );
}

// ---- server card ---------------------------------------------------------

function ServerCard({ ucm, onEdit }: { ucm: Ucm; onEdit: () => void }) {
  const remove = useUcmsStore((s) => s.remove);
  const refreshSchema = useSchemaStore((s) => s.refresh);
  const fetchingSchema = useSchemaStore((s) => s.fetching === ucm.id);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestUcmResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const hue = ucmHue(ucm.id);

  async function runSchemaFetch() {
    try {
      const info = await refreshSchema(ucm.id);
      toast.success(`Schema fetched from ${ucm.name}`, {
        description: `${info.tableCount.toLocaleString()} tables, ${info.columnCount.toLocaleString()} columns in ${fmtMs(info.elapsedMs)} — SQL autocomplete is live.`,
      });
    } catch (e) {
      toast.error("Schema fetch failed", { description: errMsg(e) });
    }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await ipc.testUcm(ucm.id));
    } catch (e) {
      setTest({ ok: false, message: errMsg(e), elapsedMs: 0 });
    } finally {
      setTesting(false);
    }
  }

  async function doDelete() {
    try {
      await remove(ucm.id);
      toast.success(`Deleted ${ucm.name}`);
    } catch (e) {
      toast.error("Delete failed", { description: errMsg(e) });
    }
  }

  return (
    <li className="group animate-rise rounded-lg border border-line bg-surface p-3.5 transition-colors hover:border-line-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="mt-px flex size-8 shrink-0 items-center justify-center rounded-md border border-line"
            style={{ background: `hsl(${hue} 70% 50% / 0.12)` }}
          >
            <Server className="size-4" style={{ color: `hsl(${hue} 70% 55%)` }} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">{ucm.name}</div>
            <div className="truncate font-mono text-[11px] text-mut">{ucm.host}</div>
          </div>
        </div>
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Tip content="Edit">
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${ucm.name}`} onClick={onEdit}>
              <Pencil className="size-3.5" />
            </Button>
          </Tip>
          <Tip content="Delete">
            <Button
              variant="danger-ghost"
              size="icon-sm"
              aria-label={`Delete ${ucm.name}`}
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </Tip>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded-[4px] border border-line bg-raised px-1.5 py-0.5 font-mono text-mut">
          AXL {ucm.version}
        </span>
        <span className="rounded-[4px] border border-line bg-raised px-1.5 py-0.5 font-mono text-mut">
          {ucm.username}
        </span>
        <Tip
          content={
            ucm.verifyTls
              ? "TLS certificates are verified on every request."
              : "Self-signed certificates are accepted — typical for lab CUCMs."
          }
        >
          <span
            className={cn(
              "flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5",
              ucm.verifyTls
                ? "border-ok/30 bg-ok/8 text-ok"
                : "border-line bg-raised text-mut",
            )}
          >
            {ucm.verifyTls ? <ShieldCheck className="size-3" /> : <ShieldOff className="size-3" />}
            {ucm.verifyTls ? "TLS verified" : "TLS relaxed"}
          </span>
        </Tip>
        {!ucm.hasPassword && (
          <Tip content="No password stored in the keychain — edit this server to set one.">
            <span className="flex items-center gap-1 rounded-[4px] border border-warn/35 bg-warn/8 px-1.5 py-0.5 text-warn">
              <KeyRound className="size-3" />
              no password
            </span>
          </Tip>
        )}
      </div>

      <div className="mt-3 space-y-2 border-t border-line/70 pt-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void runTest()} disabled={testing}>
            {testing ? (
              <Spinner className="size-3 text-accent" />
            ) : (
              <Activity className="size-3.5" />
            )}
            Test connection
          </Button>
          <Tip content="Read this server's table and column names to power SQL autocomplete.">
            <Button size="sm" onClick={() => void runSchemaFetch()} disabled={fetchingSchema}>
              {fetchingSchema ? (
                <Spinner className="size-3 text-accent" />
              ) : (
                <DatabaseZap className="size-3.5" />
              )}
              Fetch schema
            </Button>
          </Tip>
        </div>
        {/* Own row: the message would otherwise be crushed by the buttons. */}
        {test && (
          <div
            className={cn(
              "flex min-w-0 items-center gap-1 text-[11px]",
              test.ok ? "text-ok" : "text-err",
            )}
          >
            {test.ok ? (
              <CircleCheck className="size-3.5 shrink-0" />
            ) : (
              <CircleX className="size-3.5 shrink-0" />
            )}
            <span className="truncate" title={test.message}>
              {test.message}
            </span>
            <span className="shrink-0 text-faint">· {fmtMs(test.elapsedMs)}</span>
          </div>
        )}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent
          title={`Delete ${ucm.name}?`}
          description="Removes the server and its keychain password. Queries and favorites are unaffected."
        >
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              className="bg-err font-semibold text-white hover:bg-err/85"
              onClick={() => {
                setConfirmOpen(false);
                void doDelete();
              }}
            >
              <Trash2 className="size-3.5" />
              Delete server
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </li>
  );
}

// ---- add / edit dialog -----------------------------------------------------

function UcmDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: Ucm | null;
}) {
  const create = useUcmsStore((s) => s.create);
  const update = useUcmsStore((s) => s.update);

  const [name, setName] = useState(editing?.name ?? "");
  const [host, setHost] = useState(editing?.host ?? "");
  const [username, setUsername] = useState(editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [version, setVersion] = useState<AxlVersion>(editing?.version ?? DEFAULT_AXL_VERSION);
  const [verifyTls, setVerifyTls] = useState(editing?.verifyTls ?? false);
  const [saving, setSaving] = useState(false);

  const valid =
    name.trim() && host.trim() && username.trim() && (editing ? true : password.length > 0);

  async function save() {
    const input: UcmInput = {
      name: name.trim(),
      host: host.trim(),
      username: username.trim(),
      // On edit, blank means "leave the keychain entry untouched".
      password: password === "" ? (editing ? null : "") : password,
      version,
      verifyTls,
    };
    setSaving(true);
    try {
      if (editing) {
        await update(editing.id, input);
        toast.success(`Saved ${input.name}`);
      } else {
        await create(input);
        toast.success(`Added ${input.name}`);
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(editing ? "Save failed" : "Could not add server", { description: errMsg(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wide
        title={editing ? `Edit ${editing.name}` : "Add UCM server"}
        description={
          editing
            ? "Connection settings for this Unified CM publisher."
            : "Point AXLRows at a Unified CM publisher with an AXL-enabled account."
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void save();
          }}
          className="space-y-3.5"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="HQ-PUB"
              />
            </Field>
            <Field label="Host / IP">
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="cucm.example.com"
                className="font-mono"
                spellCheck={false}
                autoCapitalize="off"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="AXL username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="axladmin"
                className="font-mono"
                spellCheck={false}
                autoCapitalize="off"
              />
            </Field>
            <Field
              label="AXL password"
              hint={
                editing?.hasPassword ? (
                  <span className="font-normal text-faint">— leave blank to keep current</span>
                ) : undefined
              }
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={editing?.hasPassword ? "••••••••  (unchanged)" : "password"}
                autoComplete="new-password"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 items-end gap-3">
            <Field label="AXL version">
              <Select value={version} onValueChange={setVersion} options={AXL_VERSIONS} ariaLabel="AXL version" />
            </Field>
            <div className="flex h-8 items-center gap-2.5">
              <Switch checked={verifyTls} onCheckedChange={setVerifyTls} aria-label="Verify TLS certificates" />
              <span className="flex items-center gap-1.5 text-xs text-mut">
                Verify TLS certificate
                <Tip
                  content={
                    <>
                      <b className="font-medium">Off:</b> self-signed certs are accepted silently —
                      convenient for lab CUCMs, but the connection can be intercepted.
                      <br />
                      <b className="font-medium">On:</b> the server must present a certificate your
                      OS trusts.
                    </>
                  }
                >
                  <Info className="size-3.5 cursor-help text-faint" />
                </Tip>
              </span>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="primary" type="submit" disabled={!valid || saving}>
              {saving && <Spinner className="size-3" />}
              {editing ? "Save changes" : "Add server"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
