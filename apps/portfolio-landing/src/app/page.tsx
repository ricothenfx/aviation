import { AboutSection } from "@/components/about-section";
import { EvidenceSection } from "@/components/evidence-section";
import { Hero } from "@/components/hero";
import { OpsHeader } from "@/components/ops-header";
import { PlatformSection } from "@/components/platform-section";
import { SystemsSection } from "@/components/systems-section";

export default function Page() {
  return (
    <>
      <OpsHeader />
      <Hero />
      <SystemsSection />
      <PlatformSection />
      <EvidenceSection />
      <AboutSection />
    </>
  );
}
