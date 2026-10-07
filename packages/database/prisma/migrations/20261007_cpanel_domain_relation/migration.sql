ALTER TABLE "CpanelDiscoveredDomain" ADD CONSTRAINT "CpanelDiscoveredDomain_managedDomainId_fkey" FOREIGN KEY ("managedDomainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
