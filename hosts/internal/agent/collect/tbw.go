package collect

import (
	"regexp"
	"strings"
)

// ratedTBWTable maps SSD model strings, exactly as smartctl reports them in
// model_name (= lsblk MODEL for NVMe, the ATA IDENTIFY model for SATA), to
// the manufacturer's rated endurance in TB written. SMART does not report
// rated endurance; unknown models get nil and the UI shows the wear
// percentage only. Values are from manufacturer datasheets (or vendor
// server guides); datacenter drives rated in DWPD use DWPD x capacity x 365
// x warranty years. Entries whose model string or rating could not be
// confirmed were left out.
var ratedTBWTable = map[string]float64{
	// ---- Crucial ----
	"CT250MX500SSD1":  100,
	"CT500MX500SSD1":  180,
	"CT1000MX500SSD1": 360,
	"CT2000MX500SSD1": 700,
	"CT4000MX500SSD1": 1000,
	"CT250MX500SSD4":  100, // M.2
	"CT500MX500SSD4":  180,
	"CT1000MX500SSD4": 360,
	"CT2000MX500SSD4": 700,
	"CT500P3PSSD8":    110,
	"CT1000P3PSSD8":   220,
	"CT2000P3PSSD8":   440,
	"CT4000P3PSSD8":   800,
	"CT500P5PSSD8":    300,
	"CT1000P5PSSD8":   600,
	"CT2000P5PSSD8":   1200,
	"CT500T500SSD8":   300,
	"CT1000T500SSD8":  600,
	"CT2000T500SSD8":  1200,
	"CT4000T500SSD3":  2400,
	"CT1000T500SSD5":  600, // heatsink
	"CT2000T500SSD5":  1200,
	"CT4000T500SSD5":  2400,
	"CT1000T700SSD3":  600,
	"CT2000T700SSD3":  1200,
	"CT4000T700SSD3":  2400,
	"CT1000T700SSD5":  600, // heatsink
	"CT2000T700SSD5":  1200,
	"CT4000T700SSD5":  2400,

	// ---- Intel / Solidigm ----
	"INTEL SSDSC2KB240G8": 900, // D3-S4510
	"INTEL SSDSC2KB480G8": 1200,
	"INTEL SSDSC2KB960G8": 3400,
	"INTEL SSDSC2KB019T8": 7100,
	"INTEL SSDSC2KB038T8": 13100,
	"INTEL SSDSC2KB076T8": 26200,
	"INTEL SSDSC2KG240G8": 1400, // D3-S4610
	"INTEL SSDSC2KG480G8": 3000,
	"INTEL SSDSC2KG960G8": 6000,
	"INTEL SSDSC2KG038T8": 22000,
	"INTEL SSDSC2KG076T8": 44000,
	"INTEL SSDPE2KX010T8": 1920, // DC P4510
	"INTEL SSDPE2KX020T8": 2610,
	"INTEL SSDPE2KX040T8": 6300,
	"INTEL SSDPE2KX080T8": 13880,

	// ---- Kingston ----
	"KINGSTON SKC3000S512G":  400,
	"KINGSTON SKC3000S1024G": 800,
	"KINGSTON SKC3000D2048G": 1600,
	"KINGSTON SKC3000D4096G": 3200,

	// ---- Micron ----
	"Micron_5300_MTFDDAK240TDS":  657, // 5300 PRO
	"Micron_5300_MTFDDAK480TDS":  1324,
	"Micron_5300_MTFDDAK960TDS":  2628,
	"Micron_5300_MTFDDAK1T9TDS":  5256,
	"Micron_5300_MTFDDAK3T8TDS":  8410,
	"Micron_5300_MTFDDAK7T6TDS":  9110,
	"Micron_5300_MTFDDAV240TDS":  657, // M.2
	"Micron_5300_MTFDDAV480TDS":  1324,
	"Micron_5300_MTFDDAV960TDS":  2628,
	"Micron_5300_MTFDDAV1T9TDS":  5256,
	"Micron_5400_MTFDDAK240TGA":  657, // 5400 PRO
	"Micron_5400_MTFDDAK480TGA":  1324,
	"Micron_5400_MTFDDAK960TGA":  2628,
	"Micron_5400_MTFDDAK1T9TGA":  5256,
	"Micron_5400_MTFDDAK7T6TGA":  9110,
	"Micron_5400_MTFDDAV240TGA":  657, // M.2
	"Micron_5400_MTFDDAV480TGA":  1324,
	"Micron_5400_MTFDDAV960TGA":  2628,
	"Micron_7450_MTFDKBA400TFS":  2100, // 7450 MAX M.2
	"Micron_7450_MTFDKBA800TFS":  4300,
	"Micron_7450_MTFDKCC800TFS":  4300, // 7450 MAX U.3
	"Micron_7450_MTFDKCC1T6TFS":  8700,
	"Micron_7450_MTFDKCC3T2TFS":  17500,
	"Micron_7450_MTFDKCC6T4TFS":  35000,
	"Micron_7450_MTFDKCC12T8TFS": 70000,
	"Micron_7450_MTFDKBA480TFR":  800, // 7450 PRO M.2 2280
	"Micron_7450_MTFDKBA960TFR":  1700,
	"Micron_7450_MTFDKBG960TFR":  1700, // 7450 PRO M.2 22110
	"Micron_7450_MTFDKBG1T9TFR":  3650,
	"Micron_7450_MTFDKBG3T8TFR":  7300,
	"Micron_7450_MTFDKCC960TFR":  1700, // 7450 PRO U.3
	"Micron_7450_MTFDKCC1T9TFR":  3650,
	"Micron_7450_MTFDKCC3T8TFR":  7300,
	"Micron_7450_MTFDKCC7T6TFR":  14000,
	"Micron_7450_MTFDKCC15T3TFR": 28000,

	// ---- Samsung consumer NVMe ----
	"Samsung SSD 9100 PRO 1TB":               600,
	"Samsung SSD 9100 PRO 2TB":               1200,
	"Samsung SSD 9100 PRO 4TB":               2400,
	"Samsung SSD 9100 PRO 8TB":               4800,
	"Samsung SSD 9100 PRO with Heatsink 1TB": 600,
	"Samsung SSD 9100 PRO with Heatsink 2TB": 1200,
	"Samsung SSD 9100 PRO with Heatsink 4TB": 2400,
	"Samsung SSD 9100 PRO with Heatsink 8TB": 4800,
	"Samsung SSD 990 PRO 1TB":                600,
	"Samsung SSD 990 PRO 2TB":                1200,
	"Samsung SSD 990 PRO 4TB":                2400,
	"Samsung SSD 990 PRO with Heatsink 1TB":  600,
	"Samsung SSD 990 PRO with Heatsink 2TB":  1200,
	"Samsung SSD 990 PRO with Heatsink 4TB":  2400,
	"Samsung SSD 990 EVO Plus 1TB":           600,
	"Samsung SSD 990 EVO Plus 2TB":           1200,
	"Samsung SSD 990 EVO Plus 4TB":           2400,
	"Samsung SSD 990 EVO 1TB":                600,
	"Samsung SSD 990 EVO 2TB":                1200,
	"Samsung SSD 980 PRO 250GB":              150,
	"Samsung SSD 980 PRO 500GB":              300,
	"Samsung SSD 980 PRO 1TB":                600,
	"Samsung SSD 980 PRO 2TB":                1200,
	"Samsung SSD 980 PRO with Heatsink 1TB":  600,
	"Samsung SSD 980 PRO with Heatsink 2TB":  1200,
	"Samsung SSD 980 250GB":                  150,
	"Samsung SSD 980 500GB":                  300,
	"Samsung SSD 980 1TB":                    600,
	"Samsung SSD 970 EVO Plus 250GB":         150,
	"Samsung SSD 970 EVO Plus 500GB":         300,
	"Samsung SSD 970 EVO Plus 1TB":           600,
	"Samsung SSD 970 EVO Plus 2TB":           1200,
	"Samsung SSD 970 EVO 250GB":              150,
	"Samsung SSD 970 EVO 500GB":              300,
	"Samsung SSD 970 EVO 1TB":                600,
	"Samsung SSD 970 EVO 2TB":                1200,
	"Samsung SSD 970 PRO 512GB":              600,
	"Samsung SSD 970 PRO 1TB":                1200,

	// ---- Samsung consumer SATA ----
	"Samsung SSD 870 EVO 250GB":       150,
	"Samsung SSD 870 EVO 500GB":       300,
	"Samsung SSD 870 EVO 1TB":         600,
	"Samsung SSD 870 EVO 2TB":         1200,
	"Samsung SSD 870 EVO 4TB":         2400,
	"Samsung SSD 870 EVO 8TB":         4800,
	"Samsung SSD 870 QVO 1TB":         360,
	"Samsung SSD 870 QVO 2TB":         720,
	"Samsung SSD 870 QVO 4TB":         1440,
	"Samsung SSD 870 QVO 8TB":         2880,
	"Samsung SSD 860 EVO 250GB":       150,
	"Samsung SSD 860 EVO 500GB":       300,
	"Samsung SSD 860 EVO 1TB":         600,
	"Samsung SSD 860 EVO 2TB":         1200,
	"Samsung SSD 860 EVO 4TB":         2400,
	"Samsung SSD 860 EVO M.2 250GB":   150,
	"Samsung SSD 860 EVO M.2 500GB":   300,
	"Samsung SSD 860 EVO M.2 1TB":     600,
	"Samsung SSD 860 EVO M.2 2TB":     1200,
	"Samsung SSD 860 EVO mSATA 250GB": 150,
	"Samsung SSD 860 EVO mSATA 500GB": 300,
	"Samsung SSD 860 EVO mSATA 1TB":   600,

	// ---- Samsung datacenter ----
	"SAMSUNG MZ7LH240HAHQ-00005": 341, // PM883 (1.3 DWPD, 3 y)
	"SAMSUNG MZ7LH480HAHQ-00005": 683,
	"SAMSUNG MZ7LH960HAJR-00005": 1366,
	"SAMSUNG MZ7LH1T9HMLT-00005": 2733,
	"SAMSUNG MZ7LH3T8HMLT-00005": 5466,
	"SAMSUNG MZ7L3240HCHQ-00A07": 438, // PM893 (1 DWPD, 5 y)
	"SAMSUNG MZ7L3480HCHQ-00A07": 876,
	"SAMSUNG MZ7L3960HCJR-00A07": 1752,
	"SAMSUNG MZ7L31T9HBLT-00A07": 3504,
	"SAMSUNG MZ7L33T8HBLT-00A07": 7008,
	"SAMSUNG MZ7L37T6HBLA-00A07": 14016,
	"SAMSUNG MZ1LB960HAJQ-00007": 1366, // PM983 M.2 (1.3 DWPD, 3 y)
	"SAMSUNG MZ1LB1T9HALS-00007": 2733,
	"SAMSUNG MZ1LB3T8HMLA-00007": 5466,
	"SAMSUNG MZQLB960HAJR-00007": 1366, // PM983 U.2 (1.3 DWPD, 3 y)
	"SAMSUNG MZQLB1T9HAJR-00007": 2733,
	"SAMSUNG MZQLB3T8HALS-00007": 5466,
	"SAMSUNG MZQLB7T6HMLA-00007": 10932,
	"SAMSUNG MZ1L2960HCJR-00A07": 1752, // PM9A3 M.2 (1 DWPD, 5 y)
	"SAMSUNG MZ1L21T9HCLS-00A07": 3504,
	"SAMSUNG MZ1L23T8HBLA-00A07": 7008,
	"SAMSUNG MZQL2960HCJR-00A07": 1752, // PM9A3 U.2 (1 DWPD, 5 y)
	"SAMSUNG MZQL21T9HCJR-00A07": 3504,
	"SAMSUNG MZQL23T8HCLS-00A07": 7008,
	"SAMSUNG MZQL27T6HBLA-00A07": 14016,
	"SAMSUNG MZQL215THBLA-00A07": 28032,

	// ---- Seagate ----
	"Seagate FireCuda 530 ZP500GM30013":  640,
	"Seagate FireCuda 530 ZP1000GM30013": 1275,
	"Seagate FireCuda 530 ZP2000GM30013": 2550,
	"Seagate FireCuda 530 ZP4000GM30013": 5100,
	"Seagate FireCuda 530 ZP500GM30023":  640, // heatsink
	"Seagate FireCuda 530 ZP1000GM30023": 1275,
	"Seagate FireCuda 530 ZP2000GM30023": 2550,
	"Seagate FireCuda 530 ZP4000GM30023": 5100,

	// ---- WD ----
	"WD_BLACK SN770 250GB":      200,
	"WD_BLACK SN770 500GB":      300,
	"WD_BLACK SN770 1TB":        600,
	"WD_BLACK SN770 2TB":        1200,
	"WD_BLACK SN850X 1000GB":    600,
	"WD_BLACK SN850X 2000GB":    1200,
	"WD_BLACK SN850X 4000GB":    2400,
	"WD_BLACK SN850X 8000GB":    4800,
	"WD_BLACK SN850X HS 1000GB": 600, // heatsink
	"WD_BLACK SN850X HS 2000GB": 1200,
	"WD_BLACK SN850X HS 4000GB": 2400,
	"WD_BLACK SN850X HS 8000GB": 4800,
	"WD Red SN700 250GB":        500,
	"WD Red SN700 500GB":        1000,
	"WD Red SN700 1000GB":       2000,
	"WD Red SN700 2000GB":       2500,
	"WD Red SN700 4000GB":       5100,
	"WDC  WDS500G1R0A-68A4W0":   350, // Red SA500 2.5" (the drive reports two spaces)
	"WDC  WDS100T1R0A-68A4W0":   600,
	"WDC  WDS200T1R0A-68A4W0":   1300,
	"WDC  WDS400T1R0A-68A4W0":   2500,
	"WDC  WDS500G1R0B-68A4Z0":   350, // Red SA500 M.2
	"WDC  WDS100T1R0B-68A4Z0":   600,
	"WDC  WDS200T1R0B-68A4Z0":   1300,
}

var (
	tbwIndex       map[string]float64
	tbwSamsungPart map[string]float64 // "samsung mzql23t8hcls" -> TBW (OEM suffix variants)
	intelOEMRE     = regexp.MustCompile(`^(intel ssdsc2k[bg]\w+t8)[a-z]$`)
)

func init() {
	tbwIndex = make(map[string]float64, len(ratedTBWTable))
	tbwSamsungPart = map[string]float64{}
	for k, v := range ratedTBWTable {
		n := normModel(k)
		tbwIndex[n] = v
		if strings.HasPrefix(n, "samsung mz") {
			part, _, _ := strings.Cut(n, "-")
			tbwSamsungPart[part] = v
		}
	}
}

// normModel lower-cases and collapses whitespace (WD SA500 report two
// spaces after "WDC"; lsblk sometimes pads with trailing spaces).
func normModel(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}

// ratedTBW returns the rated endurance for a model, or nil when unknown.
// Besides exact matches it accepts OEM variants of the same hardware:
// Samsung datacenter part numbers with another "-xxxxx" suffix, Intel
// D3-S45x0/S46x0 with a vendor letter appended, and Micron "_SED" models.
func ratedTBW(model string) *float64 {
	n := normModel(model)
	if n == "" {
		return nil
	}
	if v, ok := tbwIndex[n]; ok {
		return ptr(v)
	}
	if strings.HasPrefix(n, "samsung mz") {
		part, _, _ := strings.Cut(n, "-")
		if v, ok := tbwSamsungPart[part]; ok {
			return ptr(v)
		}
	}
	if m := intelOEMRE.FindStringSubmatch(n); m != nil {
		if v, ok := tbwIndex[m[1]]; ok {
			return ptr(v)
		}
	}
	if s, ok := strings.CutSuffix(n, "_sed"); ok {
		if v, ok := tbwIndex[s]; ok {
			return ptr(v)
		}
	}
	return nil
}
