import { useState } from "react";
import { Users, Plus, Trash2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWalletStore } from "@/store/walletStore";
import { shortenAddress, copyToClipboard } from "@/lib/utils";
import { PublicKey } from "@solana/web3.js";

export function AddressBook() {
  const { contacts, addContact, removeContact } = useWalletStore();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);

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
    await copyToClipboard(addr);
    setCopiedAddr(addr);
    setTimeout(() => setCopiedAddr(null), 1500);
  };

  return (
    <div className="flex flex-col gap-4 p-4 flex-1">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          Address Book
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAdd(!showAdd)}
          className="text-primary"
        >
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {showAdd && (
        <div className="p-3 rounded-xl bg-card border border-border space-y-2">
          <Input
            placeholder="Contact name"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(""); }}
          />
          <Input
            placeholder="Solana address"
            value={address}
            onChange={(e) => { setAddress(e.target.value); setError(""); }}
            className="font-mono text-xs"
          />
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd} className="flex-1">
              Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { setShowAdd(false); setError(""); }} className="flex-1">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {contacts.length === 0 && !showAdd && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
            <Users className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">No contacts yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Save addresses for quick transfers
          </p>
        </div>
      )}

      <div className="space-y-1">
        {contacts.map((contact) => (
          <div
            key={contact.address}
            className="flex items-center gap-3 p-3 rounded-xl hover:bg-accent/50 transition-colors group"
          >
            <div className="h-8 w-8 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
              <span className="text-xs font-bold text-primary">
                {contact.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{contact.name}</p>
              <p className="text-xs text-muted-foreground font-mono">
                {shortenAddress(contact.address, 6)}
              </p>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => handleCopy(contact.address)}
                className="p-1.5 rounded-lg hover:bg-muted transition-colors cursor-pointer"
              >
                {copiedAddr === contact.address ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
              <button
                onClick={() => removeContact(contact.address)}
                className="p-1.5 rounded-lg hover:bg-destructive/10 transition-colors cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
