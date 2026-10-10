import { LandingHero } from "@/components/landing/LandingHero";
import { LandingLogoStrip } from "@/components/landing/LandingLogoStrip";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { TrustStrip } from "@/components/landing/TrustStrip";

// Server component: the hero, logo strip and "how it works" cards each
// pull their own live data and motion into small client components
// (components/landing/*), so this page itself needs no "use client".
export default function Home() {
  return (
    <div>
      <LandingHero />
      <LandingLogoStrip />
      <HowItWorks />
      <TrustStrip />
    </div>
  );
}
