param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [Parameter(Mandatory)][string]$AuthorityDirectory,
  [Parameter(Mandatory)][string]$DnsName,
  [Parameter(Mandatory)][string]$IpAddress
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or later is required.' }
if ($IsWindows -and -not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as administrator to create or reuse the protected root CA.' }
if ($DnsName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$') { throw 'Invalid DNS name.' }
$certificateFolder = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $certificateFolder) {
  if ((Get-ChildItem -LiteralPath $certificateFolder -Force | Measure-Object).Count -gt 0) { throw 'Certificate folder must be empty; existing certificates are never overwritten.' }
} else { New-Item -ItemType Directory -Path $certificateFolder | Out-Null }
$certificateIp = [Net.IPAddress]::Parse($IpAddress)
$authorityFolder = [IO.Path]::GetFullPath($AuthorityDirectory)
if ($certificateFolder -eq $authorityFolder -or $authorityFolder.StartsWith($certificateFolder + [IO.Path]::DirectorySeparatorChar)) { throw 'The root CA must be stored outside the application certificate folder.' }
$issuerPrivate = Join-Path $authorityFolder 'private'
$issuerKeyFile = Join-Path $issuerPrivate 'root-key.pem'
$issuerCertFile = Join-Path $authorityFolder 'root-ca.pem'
$start = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$expiry = [DateTimeOffset]::UtcNow.AddYears(1)
$caKey = $null
$serverKey = [Security.Cryptography.RSA]::Create(3072)
try {
  if ((Test-Path -LiteralPath $issuerKeyFile) -and (Test-Path -LiteralPath $issuerCertFile)) {
    $ca = [Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($issuerCertFile, $issuerKeyFile)
    if ($ca.NotAfter.ToUniversalTime() -le $expiry.UtcDateTime) { throw 'Root CA expires too soon; renew the authority explicitly.' }
  } else {
    if (Test-Path -LiteralPath $authorityFolder) { throw 'Authority folder already exists without a complete CA. It will not be overwritten.' }
    New-Item -ItemType Directory -Path $issuerPrivate -Force | Out-Null
    if ($IsWindows) {
      $acl = [Security.AccessControl.DirectorySecurity]::new()
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($sidText in @('S-1-5-18','S-1-5-32-544')) {
        $sid = [Security.Principal.SecurityIdentifier]::new($sidText)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
      }
      Set-Acl -LiteralPath $issuerPrivate -AclObject $acl
    }
    $caKey = [Security.Cryptography.RSA]::Create(4096)
    $caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$DnsName Root CA", $caKey, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $true, 0, $true))
    $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign, $true))
    $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false))
    $ca = $caRequest.CreateSelfSigned($start, $start.AddYears(5))
    [IO.File]::WriteAllText($issuerKeyFile, $caKey.ExportPkcs8PrivateKeyPem())
    [IO.File]::WriteAllText($issuerCertFile, $ca.ExportCertificatePem())
    [IO.File]::WriteAllBytes((Join-Path $authorityFolder 'root-ca.cer'), $ca.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  }
  $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$DnsName", $serverKey, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
  $usage = [Security.Cryptography.OidCollection]::new()
  $usage.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usage, $true))
  $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName($DnsName)
  $san.AddDnsName('localhost')
  $san.AddIpAddress($certificateIp)
  $san.AddIpAddress([Net.IPAddress]::Loopback)
  $request.CertificateExtensions.Add($san.Build())
  $serial = [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
  $serial[0] = $serial[0] -band 127
  $leaf = $request.Create($ca, $start, $expiry, $serial)
  [IO.File]::WriteAllText((Join-Path $certificateFolder 'server-key.pem'), $serverKey.ExportPkcs8PrivateKeyPem())
  [IO.File]::WriteAllText((Join-Path $certificateFolder 'server-chain.pem'), $leaf.ExportCertificatePem() + "`n" + $ca.ExportCertificatePem())
  [IO.File]::WriteAllText((Join-Path $certificateFolder 'lan-ca.pem'), $ca.ExportCertificatePem())
  [IO.File]::WriteAllBytes((Join-Path $certificateFolder 'lan-ca.cer'), $ca.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  [ordered]@{ dnsName=$DnsName; ipAddress=$IpAddress; expires=$expiry.ToString('o'); caSha256=$ca.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256); outputDirectory=$certificateFolder } | ConvertTo-Json
} finally {
  # Issuer key is administrator-only, separate from the app's readable server key.
  if ($null -ne $caKey) { $caKey.Dispose() }
  if ($null -ne $ca) { $ca.Dispose() }
  $serverKey.Dispose()
}
