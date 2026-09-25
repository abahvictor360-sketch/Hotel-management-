param([Parameter(Mandatory=$true)][string]$PrinterName,[Parameter(Mandatory=$true)][string]$FilePath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class HotelRawPrinter {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct DOCINFO { public string name; public string output; public string type; }
 [DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool OpenPrinter(string name,out IntPtr handle,IntPtr defaults);
 [DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)] static extern int StartDocPrinter(IntPtr handle,int level,ref DOCINFO info);
 [DllImport("winspool.drv",SetLastError=true)] static extern bool WritePrinter(IntPtr handle,byte[] data,int count,out int written);
 [DllImport("winspool.drv")] static extern bool EndDocPrinter(IntPtr handle);
 [DllImport("winspool.drv")] static extern bool ClosePrinter(IntPtr handle);
 public static void Print(string printer,byte[] data) {
  IntPtr handle; if(!OpenPrinter(printer,out handle,IntPtr.Zero)) throw new Exception("Cannot open printer queue");
  try { var info=new DOCINFO{name="Hotel receipt",type="RAW"}; if(StartDocPrinter(handle,1,ref info)==0) throw new Exception("Cannot start print job");
   try {int written;if(!WritePrinter(handle,data,data.Length,out written)||written!=data.Length)throw new Exception("Incomplete print transfer");}finally{EndDocPrinter(handle);}
  }finally{ClosePrinter(handle);}
 }
}
'@
[HotelRawPrinter]::Print($PrinterName,[System.IO.File]::ReadAllBytes($FilePath))
