import { useState } from "react";
import { Users, Plus, Trash2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScreenShell } from "@/components/layout/ScreenShell";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useWalletStore } from "@/store/walletStore";
import { shortenAddress } from "@/lib/utils";
import { PublicKey } from "@solana/web3.js";
import type { WalletView } from "@/types";

interface AddressBookProps {
  onNavigate: (view: WalletView) => void;
}

export function AddressBook({ onNavigate }: AddressBookProps) {
  const { contacts, addContact, removeContact } = useWalletStore();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const { copy, isCopied, copyError } = useCopyToClipboard({ resetAfterMs: 1500 });

  const handleAdd = () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    try {
      new PublicKey(address);
    } catch {
      setError("Invalid Solana address");
      return;
    }
    addContact({ name: name.trim(), address });
    setName("");
    setAddress("");
    setShowAdd(false);
    setError("");
  };

  const handleCopy = async (addr: string) => {
    await copy(addr, addr);
  };

  return (
    <ScreenShell
      title="Address Book"
      description="Save trusted recipients so transfers feel faster and safer."
      onBack={() => onNavigate("settings")}
      backLabel="Back to settings"
      actions={(
        <Button
          variant={showAdd ? "secondary" : "outline"}
          size="sm"
          onClick={() => setShowAdd(!showAdd)}
        >
          <Plus className="h-4 w-4" />
          {showAdd ? "Hide form" : "Add contact"}
        </Button>
      )}
    >
      <div className="space-y-4">
        {showAdd && (
          <Card className="p-4 space-y-3">
            <div>
              <p className="text-sm font-medium">New recipient</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a label and wallet address for future sends.
              </p>
            </div>
            <div className="space-y-2">
              <Input
                placeholder="Contact name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError("");
                }}
              />
              <Input
                placeholder="Solana address"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setError("");
                }}
                className="font-mono text-xs"
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAdd} className="flex-1">
                Save contact
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setShowAdd(false);
                  setError("");
                }}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </Card>
        )}

        {copyError && <p className="text-xs text-destructive">{copyError}</p>}

        {contacts.length === 0 && !showAdd ? (
          <Card className="flex flex-col items-center justify-center p-6 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No contacts yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Save frequent recipients here to speed up sends.
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {contacts.map((contact) => (
              <Card
                key={contact.address}
                className="flex items-center gap-3 border-border/80 bg-card/60 px-3 py-3"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/15 shrink-0">
                  <span className="text-xs font-bold text-primary">
                    {contact.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{contact.name}</p>
                  <p className="mt-1 text-xs font-mono text-muted-foreground">
                    {shortenAddress(contact.address, 6)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant={isCopied(contact.address) ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => void handleCopy(contact.address)}
                  >
                    {isCopied(contact.address) ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-success" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        Copy
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeContact(contact.address)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </ScreenShell>
  );
}
