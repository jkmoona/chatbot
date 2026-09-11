"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Chat" },
  { href: "/documents", label: "Documents" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="nav">
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} data-active={pathname === link.href}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
