// UnderTeX horizontal logo. Both variants are rendered and CSS shows the one
// matching `html[data-theme]` (see App.css), so a theme switch needs no re-render.

interface BrandLogoProps {
  className?: string;
  title?: string;
}

export default function BrandLogo({ className = "", title = "UnderTeX" }: BrandLogoProps) {
  return (
    <span className={`inline-flex items-center ${className}`} title={title}>
      <img src="/brand/logo-dark.png" alt={title} className="brand-logo--dark h-full w-auto select-none" draggable={false} />
      <img src="/brand/logo-light.png" alt={title} className="brand-logo--light h-full w-auto select-none" draggable={false} />
    </span>
  );
}
