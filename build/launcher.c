/* Caplis.exe - lanzador nativo. Arranca Electron sobre esta misma carpeta.
   Busca node_modules\electron\dist\electron.exe junto al .exe y lanza la app. */
#include <windows.h>
#include <shlwapi.h>
#include <stdio.h>

int WINAPI WinMain(HINSTANCE hI, HINSTANCE hP, LPSTR lpCmd, int nCmd) {
    char exeDir[MAX_PATH];
    GetModuleFileNameA(NULL, exeDir, MAX_PATH);
    PathRemoveFileSpecA(exeDir); /* carpeta del .exe */

    char electron[MAX_PATH];
    snprintf(electron, MAX_PATH, "%s\\node_modules\\electron\\dist\\electron.exe", exeDir);

    if (!PathFileExistsA(electron)) {
        MessageBoxA(NULL,
            "No se encuentra Electron.\n\nAbre una terminal en la carpeta de Caplis y ejecuta:\n   npm install",
            "Caplis", MB_ICONERROR | MB_OK);
        return 1;
    }

    /* Comando: "electron.exe" "<carpeta app>" */
    char cmdline[MAX_PATH * 2 + 16];
    snprintf(cmdline, sizeof(cmdline), "\"%s\" \"%s\"", electron, exeDir);

    STARTUPINFOA si; PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmdline, NULL, NULL, FALSE, 0, NULL, exeDir, &si, &pi)) {
        char msg[512];
        snprintf(msg, sizeof(msg), "No se pudo iniciar Caplis (error %lu).", GetLastError());
        MessageBoxA(NULL, msg, "Caplis", MB_ICONERROR | MB_OK);
        return 1;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
